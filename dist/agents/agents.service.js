var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var AgentsService_1;
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { AdaptersService } from '../adapters/adapters.service.js';
import { DaemonClient, DaemonError, } from '../daemon/daemon-client.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
export const LABEL_PREFIX = 'agent-manager:';
const toAgent = (r) => ({
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    profile: r.profile,
    cwd: r.cwd,
    vendorConversationId: r.vendor_conversation_id,
    currentSessionId: r.current_session_id,
    createdAt: r.created_at,
    archivedAt: r.archived_at,
});
export function emptyCounts() {
    return {
        starting: 0,
        idle: 0,
        working: 0,
        'waiting-input': 0,
        'waiting-permission': 0,
        error: 0,
        exited: 0,
    };
}
let AgentsService = AgentsService_1 = class AgentsService extends EventEmitter {
    dbs;
    daemon;
    adapters;
    projects;
    logger = new Logger(AgentsService_1.name);
    live = new Map();
    sessionOwner = new Map();
    constructor(dbs, daemon, adapters, projects) {
        super();
        this.dbs = dbs;
        this.daemon = daemon;
        this.adapters = adapters;
        this.projects = projects;
    }
    get db() {
        return this.dbs.db;
    }
    onModuleInit() {
        this.daemon.on('output', (id, record) => this.onOutput(id, record));
        this.daemon.on('changed', (session) => this.onSessionChanged(session));
        this.daemon.on('connected', () => void this.resync().catch((err) => this.logger.error(`resync failed: ${err.message}`)));
        this.daemon.on('disconnected', () => this.onDaemonLost());
    }
    list(projectId) {
        this.projects.get(projectId);
        return this.db
            .prepare('SELECT * FROM agents WHERE project_id = ? AND archived_at IS NULL ORDER BY created_at')
            .all(projectId)
            .map(toAgent)
            .map((agent) => ({ agent, status: this.ensureLive(agent).status }));
    }
    get(id) {
        const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
        if (!row)
            throw new NotFoundException(`no agent ${id}`);
        return toAgent(row);
    }
    status(id) {
        return this.ensureLive(this.get(id)).status;
    }
    sessions(id) {
        return this.db
            .prepare('SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at')
            .all(id).map((r) => ({
            daemonSessionId: r.daemon_session_id,
            startedAt: r.started_at,
            endedAt: r.ended_at,
        }));
    }
    items(id, from = 0) {
        const live = this.ensureLive(this.get(id));
        return from <= 0 ? live.items : live.items.slice(from);
    }
    counts(projectId) {
        const counts = emptyCounts();
        for (const { status } of this.list(projectId))
            counts[status.state]++;
        return counts;
    }
    async create(projectId, input) {
        const project = this.projects.get(projectId);
        const profile = input.profile ?? project.defaultProfile;
        if (typeof input.name !== 'string' || input.name.trim() === '')
            throw new BadRequestException('"name" is required');
        if (typeof profile !== 'string')
            throw new BadRequestException('"profile" is required (or set the project default)');
        if (!this.adapters.supports(profile))
            throw new BadRequestException(`no adapter for profile "${profile}"`);
        if (input.cwd !== undefined && typeof input.cwd !== 'string')
            throw new BadRequestException('"cwd" must be a string');
        const cwd = input.cwd ?? project.path;
        const others = this.list(projectId).filter((a) => a.agent.cwd === cwd && a.status.state !== 'exited');
        if (others.length)
            this.logger.warn(`agent "${input.name}" shares cwd ${cwd} with ${others.map((o) => o.agent.name).join(', ')}; two writers in one tree is on the user`);
        const agent = {
            id: randomUUID(),
            projectId,
            name: input.name.trim(),
            profile,
            cwd,
            vendorConversationId: null,
            currentSessionId: null,
            createdAt: Date.now(),
            archivedAt: null,
        };
        this.db
            .prepare('INSERT INTO agents (id, project_id, name, profile, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(agent.id, projectId, agent.name, profile, cwd, agent.createdAt);
        const live = this.ensureLive(agent);
        await this.startSession(agent, live);
        return { agent: this.get(agent.id), status: live.status };
    }
    async turn(id, text) {
        if (typeof text !== 'string' || text.length === 0)
            throw new BadRequestException('"text" is required');
        let agent = this.get(id);
        if (agent.archivedAt)
            throw new ConflictException('agent is archived');
        const live = this.ensureLive(agent);
        if (live.starting)
            await live.starting;
        agent = this.get(id);
        if (!agent.currentSessionId) {
            await this.startSession(agent, live);
            agent = this.get(id);
        }
        for (const line of live.adapter.turn(text))
            await this.daemon.input(agent.currentSessionId, line);
    }
    async interrupt(id) {
        const agent = this.get(id);
        const live = this.ensureLive(agent);
        if (!agent.currentSessionId || !live.adapter?.interrupt)
            throw new ConflictException('nothing to interrupt');
        for (const line of live.adapter.interrupt())
            await this.daemon.input(agent.currentSessionId, line);
    }
    async stop(id) {
        const agent = this.get(id);
        if (!agent.currentSessionId)
            return;
        try {
            await this.daemon.endInput(agent.currentSessionId);
        }
        catch (err) {
            if (!(err instanceof DaemonError) || err.code === 'disconnected')
                throw err;
            await this.daemon
                .signal(agent.currentSessionId, 'SIGTERM')
                .catch(() => undefined);
        }
    }
    async archive(id) {
        await this.stop(id);
        this.db
            .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
            .run(Date.now(), id);
        const agent = this.get(id);
        this.emit('counts', agent.projectId, this.counts(agent.projectId));
    }
    async startSession(agent, live) {
        if (live.starting)
            return live.starting;
        live.starting = (async () => {
            const adapter = this.adapters.create(agent.profile);
            live.adapter = adapter;
            live.lastSeq = 0;
            const session = await this.daemon.start({
                profile: agent.profile,
                args: adapter.startArgs({ resume: agent.vendorConversationId }),
                cwd: agent.cwd,
                label: `${LABEL_PREFIX}${agent.id}`,
                attach: true,
            });
            this.db
                .prepare('INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at) VALUES (?, ?, ?)')
                .run(session.id, agent.id, session.startedAt);
            this.db
                .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
                .run(session.id, agent.id);
            this.sessionOwner.set(session.id, agent.id);
            this.appendItem(agent.id, live, session.id, 0, {
                kind: 'system',
                text: agent.vendorConversationId
                    ? `session resumed (${session.id})`
                    : `session started (${session.id})`,
            });
            this.setState(agent, live, 'idle', null);
            this.emit('session', agent.id, {
                daemonSessionId: session.id,
                startedAt: session.startedAt,
                endedAt: null,
            });
        })().finally(() => {
            live.starting = null;
        });
        return live.starting;
    }
    onOutput(sessionId, record) {
        const agentId = this.sessionOwner.get(sessionId);
        if (!agentId)
            return;
        const live = this.live.get(agentId);
        if (!live?.adapter)
            return;
        if (record.seq <= live.lastSeq)
            return;
        live.lastSeq = record.seq;
        const agent = this.get(agentId);
        this.apply(agent, live, sessionId, record, live.adapter.ingest(record));
    }
    apply(agent, live, sessionId, record, ingest) {
        if (ingest.conversationId &&
            ingest.conversationId !== agent.vendorConversationId) {
            this.db
                .prepare('UPDATE agents SET vendor_conversation_id = ? WHERE id = ?')
                .run(ingest.conversationId, agent.id);
            agent.vendorConversationId = ingest.conversationId;
        }
        if (ingest.updateLast) {
            const last = live.items[live.items.length - 1];
            if (last && last.item.kind === ingest.updateLast.kind) {
                last.item = ingest.updateLast;
                last.seq = record.seq;
                this.emit('item', agent.id, last);
            }
            else {
                this.appendItem(agent.id, live, sessionId, record.seq, ingest.updateLast);
            }
        }
        for (const item of ingest.append ?? [])
            this.appendItem(agent.id, live, sessionId, record.seq, item);
        if (ingest.state)
            this.setState(agent, live, ingest.state, ingest.error ?? null);
    }
    onSessionChanged(session) {
        const agentId = this.sessionOwner.get(session.id) ??
            (session.label?.startsWith(LABEL_PREFIX)
                ? session.label.slice(LABEL_PREFIX.length)
                : undefined);
        if (!agentId || session.state !== 'exited')
            return;
        const row = this.db
            .prepare('SELECT * FROM agents WHERE id = ?')
            .get(agentId);
        if (!row)
            return;
        const agent = toAgent(row);
        const live = this.ensureLive(agent);
        this.db
            .prepare('UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ?')
            .run(session.exitedAt ?? Date.now(), session.id);
        if (agent.currentSessionId === session.id) {
            this.db
                .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?')
                .run(agent.id);
            agent.currentSessionId = null;
            const why = session.exitReason
                ? ` (${session.exitReason})`
                : session.signal
                    ? ` (${session.signal})`
                    : ` (exit code ${session.exitCode})`;
            this.appendItem(agent.id, live, session.id, session.lastSeq, {
                kind: 'system',
                text: `session ended${why}`,
            });
            this.setState(agent, live, 'exited', null);
            this.emit('session', agent.id, {
                daemonSessionId: session.id,
                startedAt: session.startedAt,
                endedAt: session.exitedAt,
            });
        }
    }
    async resync() {
        const sessions = await this.daemon.listSessions();
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const rows = this.db
            .prepare('SELECT * FROM agents WHERE archived_at IS NULL')
            .all();
        for (const row of rows) {
            const agent = toAgent(row);
            const live = this.ensureLive(agent);
            const refs = this.sessions(agent.id);
            for (const s of sessions) {
                if (s.label === `${LABEL_PREFIX}${agent.id}` &&
                    !refs.some((r) => r.daemonSessionId === s.id)) {
                    this.db
                        .prepare('INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
                        .run(s.id, agent.id, s.startedAt, s.exitedAt);
                    refs.push({
                        daemonSessionId: s.id,
                        startedAt: s.startedAt,
                        endedAt: s.exitedAt,
                    });
                }
            }
            const fresh = live.items.length === 0;
            if (fresh) {
                for (const [i, ref] of refs.entries()) {
                    const s = byId.get(ref.daemonSessionId);
                    if (!s)
                        continue;
                    await this.replay(agent, live, s, 1, i === 0 ? 'session started' : 'session resumed');
                }
            }
            else if (agent.currentSessionId && byId.has(agent.currentSessionId)) {
                await this.replay(agent, live, byId.get(agent.currentSessionId), live.lastSeq + 1);
            }
            const current = agent.currentSessionId
                ? byId.get(agent.currentSessionId)
                : undefined;
            if (agent.currentSessionId && (!current || current.state === 'exited')) {
                if (current)
                    this.onSessionChanged(current);
                else {
                    this.db
                        .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ?')
                        .run(agent.id);
                    this.setState(agent, live, 'exited', null);
                }
            }
        }
        this.logger.log(`resynced ${rows.length} agent(s) against ${sessions.length} daemon session(s)`);
    }
    async replay(agent, live, session, fromSeq, label = 'session started') {
        live.adapter =
            live.adapter && session.id === agent.currentSessionId && fromSeq > 1
                ? live.adapter
                : this.adapters.create(agent.profile);
        this.sessionOwner.set(session.id, agent.id);
        if (fromSeq === 1) {
            live.lastSeq = 0;
            this.appendItem(agent.id, live, session.id, 0, {
                kind: 'system',
                text: `${label} (${session.id})`,
            });
        }
        try {
            await this.daemon.attach(session.id, fromSeq);
        }
        catch (err) {
            this.logger.warn(`replay of ${session.id} for agent ${agent.id} failed: ${err.message}`);
            this.appendItem(agent.id, live, session.id, 0, {
                kind: 'system',
                text: `history unavailable: ${err.message}`,
            });
        }
        if (session.state === 'exited' && session.id !== agent.currentSessionId) {
            this.appendItem(agent.id, live, session.id, session.lastSeq, {
                kind: 'system',
                text: 'session ended',
            });
        }
    }
    onDaemonLost() {
        for (const [agentId, live] of this.live) {
            const agent = this.get(agentId);
            if (live.status.state !== 'exited')
                this.setState(agent, live, 'error', 'connection to agent-daemon lost');
        }
    }
    ensureLive(agent) {
        let live = this.live.get(agent.id);
        if (!live) {
            live = {
                adapter: null,
                status: {
                    state: agent.currentSessionId ? 'starting' : 'exited',
                    error: null,
                    lastActivityAt: agent.createdAt,
                },
                items: [],
                lastSeq: 0,
                starting: null,
            };
            this.live.set(agent.id, live);
        }
        return live;
    }
    appendItem(agentId, live, sessionId, seq, item) {
        const stored = {
            index: live.items.length,
            sessionId,
            seq,
            item,
        };
        live.items.push(stored);
        live.status.lastActivityAt = Date.now();
        this.emit('item', agentId, stored);
    }
    setState(agent, live, state, error) {
        if (live.status.state === state && live.status.error === error)
            return;
        live.status = { state, error, lastActivityAt: Date.now() };
        this.emit('state', agent.id, agent.projectId, live.status);
        this.emit('counts', agent.projectId, this.counts(agent.projectId));
    }
};
AgentsService = AgentsService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [DbService,
        DaemonClient,
        AdaptersService,
        ProjectsService])
], AgentsService);
export { AgentsService };
//# sourceMappingURL=agents.service.js.map