import { BroadcastChannel } from 'broadcast-channel';
import EventEmitter from 'events';
import MiniSearch, { SearchResult } from 'minisearch'
import { v4 as uuidv4 } from 'uuid';
import { Chat, getOpenAIMessageFromMessage, Message, Parameters, UserSubmittedMessage } from './types';
import { MessageTree } from './message-tree';
import { createStreamingChatCompletion } from './openai';
import { createTitle } from './titles';
import { ellipsize, sleep } from './utils';
import * as idb from './idb';
import { selectMessagesToSendSafely } from './tokenizer';

export const channel = new BroadcastChannel('chats');

export class ChatManager extends EventEmitter {
    public chats = new Map<string, Chat>();
    public search = new Search(this.chats);
    private loaded = false;
    private changed = false;

    constructor() {
        super();
        this.load();
        
        this.on('update', () => {
            this.changed = true;
        });

        channel.onmessage = (message: {
            type: 'chat-update',
            data: Chat,
        }) => {
            const id = message.data.id;
            this.chats.set(id, message.data);
            this.emit(id);
        };

        (async () => {
            while (true) {
                await sleep(100);

                if (this.loaded && this.changed) {
                    this.changed = false;
                    await this.save();
                }
            }
        })();
    }

    public async createChat(): Promise<string> {
        const id = uuidv4();

        const chat: Chat = {
            id,
            messages: new MessageTree(),
            created: Date.now(),
            updated: Date.now(),
        };

        this.chats.set(id, chat);
        this.search.update(chat);
        channel.postMessage({ type: 'chat-update', data: chat });

        return id;
    }

    public async sendMessage(message: UserSubmittedMessage) {
        const chat = this.chats.get(message.chatID);

        if (!chat) {
            throw new Error('Chat not found');
        }

        const newMessage: Message = {
            id: uuidv4(),
            parentID: message.parentID,
            chatID: chat.id,
            timestamp: Date.now(),
            role: 'user',
            content: message.content,
            done: true,
        };

        chat.messages.addMessage(newMessage);
        chat.updated = Date.now();

        this.emit(chat.id);
        this.emit('messages', [newMessage]);
        channel.postMessage({ type: 'chat-update', data: chat });

        const messages: Message[] = message.parentID
            ? chat.messages.getMessageChainTo(message.parentID)
            : [];
        messages.push(newMessage);

        await this.getReply(messages, message.requestedParameters);
    }

    public async regenerate(message: Message, requestedParameters: Parameters) {
        const chat = this.chats.get(message.chatID);

        if (!chat) {
            throw new Error('Chat not found');
        }

        const messages: Message[] = message.parentID
            ? chat.messages.getMessageChainTo(message.parentID)
            : [];

        await this.getReply(messages, requestedParameters);
    }

    private async getReply(messages: Message[], requestedParameters: Parameters) {
        const latestMessage = messages[messages.length - 1];
        const chat = this.chats.get(latestMessage.chatID);

        if (!chat) {
            throw new Error('Chat not found');
        }

        const reply: Message = {
            id: uuidv4(),
            parentID: latestMessage.id,
            chatID: latestMessage.chatID,
            timestamp: Date.now(),
            role: 'assistant',
            content: '',
            done: false,
        };

        chat.messages.addMessage(reply);
        chat.updated = Date.now();

        this.emit(chat.id);
        channel.postMessage({ type: 'chat-update', data: chat });

        const messagesToSend = selectMessagesToSendSafely(messages.map(getOpenAIMessageFromMessage));

        const response = await createStreamingChatCompletion(messagesToSend, requestedParameters);

        response.on('error', () => {
            if (!reply.content) {
                reply.content += "\n\nI'm sorry, I'm having trouble connecting to OpenAI. Please make sure you've entered your OpenAI API key correctly and try again.";
                reply.content = reply.content.trim();
                reply.done = true;
                chat.messages.updateMessage(reply);
                chat.updated = Date.now();
                this.emit(chat.id);
                this.emit('messages', [reply]);
                channel.postMessage({ type: 'chat-update', data: chat });
            }
        })

        response.on('data', (data: string) => {
            reply.content = data;
            chat.messages.updateMessage(reply);
            this.emit(chat.id);
            channel.postMessage({ type: 'chat-update', data: chat });
        });

        response.on('done', async () => {
            reply.done = true;
            chat.messages.updateMessage(reply);
            chat.updated = Date.now();
            this.emit(chat.id);
            this.emit('messages', [reply]);
            this.emit('update');
            channel.postMessage({ type: 'chat-update', data: chat });
            setTimeout(() => this.search.update(chat), 500);

            if (!chat.title) {
                chat.title = await createTitle(chat, requestedParameters.apiKey);
                if (chat.title) {
                    this.emit(chat.id);
                    this.emit('title', chat.id, chat.title);
                    this.emit('update');
                    channel.postMessage({ type: 'chat-update', data: chat });
                    setTimeout(() => this.search.update(chat), 500);
                }
            }
        });
    }

    private async save() {
        const serialized = Array.from(this.chats.values())
            .map((c) => {
                const serialized = { ...c } as any;
                serialized.messages = c.messages.serialize();
                return serialized;
            });
        await idb.set('chats', serialized);
    }

    private async load() {
        const serialized = await idb.get('chats');
        if (serialized) {
            for (const chat of serialized) {
                const messages = new MessageTree();
                for (const m of chat.messages) {
                    messages.addMessage(m);
                }
                chat.messages = messages;
                this.loadChat(chat);
            }
            this.emit('update');
        }
        this.loaded = true;
    }

    public loadChat(chat: Chat) {
        if (!chat?.id) {
            return;
        }
        this.chats.set(chat.id, chat);
        this.search.update(chat);
        this.emit(chat.id);
    }

    public get(id: string): Chat | undefined {
        return this.chats.get(id);
    }
}

export class Search {
    private index = new MiniSearch({
        fields: ['value'],
        storeFields: ['id', 'value'],
    });

    constructor(private chats: Map<string, Chat>) {
    }

    public update(chat: Chat) {
        const messages = chat.messages.serialize()
            .map((m: Message) => m.content)
            .join('\n\n');
        const doc = {
            id: chat.id,
            value: chat.title + '\n\n' + messages,
        };
        if (!this.index.has(chat.id)) {
            this.index.add(doc);
        } else {
            this.index.replace(doc);
        }
    }

    public query(query: string) {
        if (!query?.trim().length) {
            const searchResults = Array.from(this.chats.values())
                .sort((a, b) => b.updated - a.updated)
                .slice(0, 10);
            const results = this.processSearchResults(searchResults);
            return results;
        }

        let searchResults = this.index.search(query, { fuzzy: 0.2 });
        let output = this.processSearchResults(searchResults);

        if (!output.length) {
            searchResults = this.index.search(query, { prefix: true });
            output = this.processSearchResults(searchResults);
        }

        return output;
    }

    private processSearchResults(searchResults: SearchResult[] | Chat[]) {
        const output: any[] = [];
        for (const item of searchResults) {
            const chatID = item.id;
            let chat = this.chats.get(chatID);
            if (!chat) {
                continue;
            }

            chat = { ...chat };

            let description = chat.messages?.first?.content || '';
            description = ellipsize(description, 400);

            if (!chat.title) {
                chat.title = ellipsize(description, 100);
            }

            if (!chat.title || !description) {
                continue;
            }
            
            output.push({
                chatID,
                title: chat.title,
                description,
            });
        }
        return output;
    }
}

const chatManager = new ChatManager();
export default chatManager;
