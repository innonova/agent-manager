import type { Request, Response } from 'express';
import type { ManagerConfig } from '../config/config.js';
import { AuthService, User } from './auth.service.js';
export declare class AuthController {
    private readonly config;
    private readonly auth;
    constructor(config: ManagerConfig, auth: AuthService);
    login(body: {
        name?: unknown;
        password?: unknown;
    }, res: Response): Promise<{
        user: User;
    }>;
    logout(req: Request & {
        sessionId?: string;
    }, res: Response): {
        ok: true;
    };
    me(req: Request & {
        user?: User;
    }): {
        user: User;
    };
}
