import { ProjectsService } from '../projects/projects.service.js';
export interface DirEntry {
    name: string;
    path: string;
    type: 'file' | 'dir' | 'symlink' | 'other';
    size: number;
    mtime: number;
}
export interface FileContent {
    path: string;
    size: number;
    mtime: number;
    content: string;
    binary: boolean;
    truncated: boolean;
}
export declare const MAX_FILE_BYTES: number;
export declare class FilesService {
    private readonly projects;
    constructor(projects: ProjectsService);
    resolve(projectId: string, rel: unknown): {
        abs: string;
        rel: string;
        repo: string;
    } | {
        root: true;
    };
    list(projectId: string, rel: unknown): Promise<{
        path: string;
        entries: DirEntry[];
    }>;
    read(projectId: string, rel: unknown): Promise<FileContent>;
}
