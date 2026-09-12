import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import type { ManagerConfig } from '../config/config.js';
export declare class DbService implements OnModuleInit, OnModuleDestroy {
    private readonly config;
    db: Database.Database;
    constructor(config: ManagerConfig);
    onModuleInit(): void;
    onModuleDestroy(): void;
}
