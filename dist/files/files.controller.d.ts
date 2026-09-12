import { DirEntry, FileContent, FilesService } from './files.service.js';
export declare class FilesController {
    private readonly files;
    constructor(files: FilesService);
    list(id: string, p?: string): Promise<{
        path: string;
        entries: DirEntry[];
    }>;
    read(id: string, p?: string): Promise<FileContent>;
}
