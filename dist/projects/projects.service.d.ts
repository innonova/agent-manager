import { DbService } from '../db/db.service.js';
export interface Project {
    id: string;
    name: string;
    path: string;
    defaultProfile: string | null;
    createdAt: number;
}
export declare class ProjectsService {
    private readonly dbs;
    constructor(dbs: DbService);
    private get db();
    list(): Project[];
    get(id: string): Project;
    create(input: {
        name?: unknown;
        path?: unknown;
        defaultProfile?: unknown;
    }): Project;
    update(id: string, input: {
        name?: unknown;
        defaultProfile?: unknown;
    }): Project;
    remove(id: string): void;
}
