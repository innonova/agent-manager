import { DbService } from '../db/db.service.js';
export interface Repo {
    name: string;
    path: string;
}
export interface Project {
    id: string;
    name: string;
    path: string;
    repos: Repo[];
    defaultProfile: string | null;
    createdAt: number;
}
export declare class ProjectsService {
    private readonly dbs;
    constructor(dbs: DbService);
    private get db();
    list(): Project[];
    get(id: string): Project;
    private toProject;
    private parseRepos;
    create(input: {
        name?: unknown;
        path?: unknown;
        repos?: unknown;
        defaultProfile?: unknown;
    }): Project;
    update(id: string, input: {
        name?: unknown;
        defaultProfile?: unknown;
        repos?: unknown;
        path?: unknown;
    }): Project;
    private saveRepos;
    remove(id: string): void;
    repoOf(project: Project, ref: string): Repo | undefined;
}
