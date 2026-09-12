import { OnModuleInit } from '@nestjs/common';
import type { ManagerConfig } from '../config/config.js';
import { DbService } from '../db/db.service.js';
export interface User {
    id: string;
    name: string;
    createdAt: number;
}
export declare class AuthService implements OnModuleInit {
    private readonly config;
    private readonly dbs;
    private readonly logger;
    constructor(config: ManagerConfig, dbs: DbService);
    private get db();
    private dummyHash;
    onModuleInit(): Promise<void>;
    createUser(name: string, password: string): Promise<User>;
    login(name: string, password: string): Promise<{
        user: User;
        sessionId: string;
    }>;
    logout(sessionId: string): void;
    userForSession(sessionId: string | undefined): User | null;
}
