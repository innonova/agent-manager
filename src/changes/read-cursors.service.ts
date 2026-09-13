import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { head } from './git.js';

/**
 * A user's "since I last looked" commit per repository. Kept apart from
 * ChangesService so the features service can advance it when a feature is
 * marked done without a dependency cycle.
 */
@Injectable()
export class ReadCursorsService {
  constructor(
    private readonly dbs: DbService,
    private readonly projects: ProjectsService,
  ) {}

  get(userId: string, projectId: string, repo: string): string | null {
    const row = this.dbs.db
      .prepare(
        'SELECT commit_hash FROM read_cursors WHERE user_id = ? AND project_id = ? AND repo = ?',
      )
      .get(userId, projectId, repo) as { commit_hash: string } | undefined;
    return row?.commit_hash ?? null;
  }

  /** Moves the cursor to HEAD in the given repositories (all of the project's by default). */
  async markRead(
    userId: string,
    projectId: string,
    repoName?: string,
  ): Promise<{ repo: string; commit: string }[]> {
    const project = this.projects.get(projectId);
    const targets = repoName
      ? project.repos.filter((r) => r.name === repoName)
      : project.repos;
    const out: { repo: string; commit: string }[] = [];
    for (const repo of targets) {
      const h = await head(repo.path);
      if (!h) continue;
      this.dbs.db
        .prepare(
          'INSERT INTO read_cursors (user_id, project_id, repo, commit_hash, read_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, project_id, repo) DO UPDATE SET commit_hash = excluded.commit_hash, read_at = excluded.read_at',
        )
        .run(userId, projectId, repo.name, h, Date.now());
      out.push({ repo: repo.name, commit: h });
    }
    return out;
  }
}
