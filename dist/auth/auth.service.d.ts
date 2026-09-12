import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
export interface User {
    id: string;
    name: string;
    createdAt: number;
}
export declare class AuthService extends EventEmitter<{
    revoked: [sessionId: string];
}> implements OnModuleInit, OnModuleDestroy {
    private readonly config;
    private readonly dbs;
    private readonly logger;
    private readonly attempts;
    private verifying;
    private readonly verifyQueue;
    private dummyHash;
    private cleanup;
    constructor(config: ManagerConfig, dbs: DbService);
    private get db();
    onModuleInit(): Promise<void>;
    onModuleDestroy(): void;
    createUser(name: string, password: string): Promise<User>;
    login(name: string, password: string, clientKey?: string): Promise<{
        user: User;
        sessionId: string;
    }>;
    logout(sessionId: string): void;
    userForSession(sessionId: string | undefined): User | null;
    private throttle;
    private verify;
}
