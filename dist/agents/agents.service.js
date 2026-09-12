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
import { BadRequestException, ConflictException, HttpException, Injectable, Logger, NotFoundException, } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AdaptersService } from '../adapters/adapters.service.js';
import { DaemonClient, DaemonError, } from '../daemon/daemon-client.js';
import { DbService } from '../db/db.service.js';
import { ProjectsService } from '../projects/projects.service.js';
export const LABEL_PREFIX = 'agent-manager:';
const STARTING_GRACE_MS = 5000;
const LOCK_PATIENCE_MS = 2000;
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
const exitWhy = (s) => s.exitReason
    ? ` (${s.exitReason})`
    : s.signal
        ? ` (${s.signal})`
        : ` (exit code ${s.exitCode})`;
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
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
};
const busy = () => new HttpException({ statusCode: 409, message: 'a turn is in progress', code: 'agent-busy' }, 409);
const unavailable = (why) => new HttpException({
    statusCode: 503,
    message: `agent unavailable: ${why}`,
    code: 'agent-unavailable',
}, 503);
const asHttp = (err) => err instanceof DaemonError ? unavailable(err.message) : err;
let AgentsService = AgentsService_1 = class AgentsService extends EventEmitter {
    dbs;
    daemon;
    adapters;
    projects;
    logger = new Logger(AgentsService_1.name);
    live = new Map();
    sessionOwner = new Map();
    deleting = new Set();
    resyncChain = Promise.resolve();
    resyncGeneration = 0;
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
        this.daemon.on('connected', () => this.scheduleResync());
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
    find(id) {
        const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
        return row ? toAgent(row) : null;
    }
    status(id) {
        return this.ensureLive(this.get(id)).status;
    }
    sessions(id) {
        return this.db
            .prepare('SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at, daemon_session_id')
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
        if (this.deleting.has(projectId))
            throw new ConflictException('project is being deleted');
        const profile = input.profile ?? project.defaultProfile;
        if (typeof input.name !== 'string' || input.name.trim() === '')
            throw new BadRequestException('"name" is required');
        if (typeof profile !== 'string')
            throw new BadRequestException('"profile" is required (or set the project default)');
        if (!this.adapters.supports(profile))
            throw new BadRequestException(`no adapter for profile "${profile}"`);
        if (input.cwd !== undefined && typeof input.cwd !== 'string')
            throw new BadRequestException('"cwd" must be a string');
        const cwd = input.cwd
            ? path.resolve(project.path, input.cwd)
            : project.path;
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
        try {
            await this.withLock(live, () => this.startSession(agent, live));
        }
        catch (err) {
            if (err instanceof DaemonError && err.code === 'disconnected') {
                throw asHttp(err);
            }
            this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
            this.live.delete(agent.id);
            throw asHttp(err);
        }
        return { agent: this.get(agent.id), status: live.status };
    }
    async turn(id, text) {
        if (typeof text !== 'string' || text.length === 0)
            throw new BadRequestException('"text" is required');
        const live = this.ensureLive(this.get(id));
        await live.synced;
        await this.withLock(live, async () => {
            let agent = this.get(id);
            if (agent.archivedAt)
                throw new ConflictException('agent is archived');
            if (this.deleting.has(agent.projectId))
                throw new ConflictException('project is being deleted');
            if (!agent.currentSessionId) {
                await this.startSession(agent, live);
                agent = this.get(id);
            }
            const attached = live.sessions.get(agent.currentSessionId);
            if (!attached)
                throw unavailable('session not tracked');
            if (!attached.replayed) {
                await this.attachSession(agent, live, attached);
                if (!attached.replayed)
                    throw unavailable('the session log could not be read');
                this.reconcileTurnState(agent, live, attached);
                agent = this.get(id);
                if (!agent.currentSessionId)
                    throw unavailable('the session had ended; send the turn again to resume');
            }
            await this.awaitStarting(live);
            if (live.status.state === 'working' || live.status.state === 'starting')
                throw busy();
            const sl = live.sessions.get(agent.currentSessionId);
            if (!sl)
                throw unavailable('session not tracked');
            const before = live.status;
            this.setState(agent, live, 'working', null);
            try {
                for (const line of sl.adapter.turn(text))
                    await this.daemon.input(agent.currentSessionId, line);
            }
            catch (err) {
                const uncertain = err instanceof DaemonError && err.code === 'disconnected';
                if (!uncertain && live.status.state === 'working')
                    this.setState(agent, live, before.state, before.error);
                throw asHttp(err);
            }
        });
    }
    async interrupt(id) {
        const live = this.ensureLive(this.get(id));
        const agent = this.get(id);
        const sl = agent.currentSessionId
            ? live.sessions.get(agent.currentSessionId)
            : undefined;
        if (!sl?.adapter.interrupt)
            throw new ConflictException('nothing to interrupt');
        try {
            for (const line of sl.adapter.interrupt())
                await this.daemon.input(agent.currentSessionId, line);
        }
        catch (err) {
            throw asHttp(err);
        }
    }
    async stop(id) {
        const live = this.ensureLive(this.get(id));
        await this.withLockOrForce(live, id, () => this.stopLocked(this.get(id)));
    }
    async archive(id) {
        const live = this.ensureLive(this.get(id));
        await this.withLockOrForce(live, id, async () => {
            const agent = this.get(id);
            await this.stopLocked(agent, true);
            this.db
                .prepare('UPDATE agents SET archived_at = ? WHERE id = ?')
                .run(Date.now(), id);
            this.emit('counts', agent.projectId, this.counts(agent.projectId));
        });
    }
    async removeProject(projectId) {
        this.deleting.add(projectId);
        try {
            for (;;) {
                const row = this.db
                    .prepare('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at LIMIT 1')
                    .get(projectId);
                if (!row)
                    return;
                const live = this.ensureLive(toAgent(row));
                await this.withLockOrForce(live, row.id, async () => {
                    const agent = this.get(row.id);
                    await this.stopLocked(agent, true);
                    for (const sid of live.sessions.keys())
                        this.sessionOwner.delete(sid);
                    this.live.delete(agent.id);
                    this.db.prepare('DELETE FROM agents WHERE id = ?').run(agent.id);
                });
            }
        }
        catch (err) {
            this.deleting.delete(projectId);
            throw asHttp(err);
        }
    }
    releaseProject(projectId) {
        this.deleting.delete(projectId);
    }
    async stopLocked(agent, wait = false) {
        if (!agent.currentSessionId && this.ensureLive(agent).syncPending) {
            this.adoptSessions(agent, await this.daemon.listSessions());
        }
        const id = agent.currentSessionId;
        if (!id)
            return;
        try {
            await this.daemon.endInput(id);
        }
        catch (err) {
            if (!(err instanceof DaemonError))
                throw err;
            if (err.code === 'disconnected' || err.code === 'not-connected')
                throw unavailable(err.message);
            if (err.code !== 'unknown-session') {
                try {
                    await this.daemon.signal(id, 'SIGTERM');
                }
                catch (e2) {
                    if (!(e2 instanceof DaemonError) ||
                        (e2.code !== 'unknown-session' && e2.code !== 'session-not-running'))
                        throw asHttp(e2);
                }
            }
        }
        if (!wait)
            return;
        for (const [signal, ms] of [
            [null, 3000],
            ['SIGTERM', 2000],
            ['SIGKILL', 2000],
        ]) {
            if (signal)
                await this.daemon.signal(id, signal).catch(() => undefined);
            const until = Date.now() + ms;
            while (Date.now() < until) {
                try {
                    const s = await this.daemon.getSession(id);
                    if (s.state === 'exited')
                        return;
                }
                catch (err) {
                    if (err instanceof DaemonError && err.code === 'unknown-session')
                        return;
                    throw asHttp(err);
                }
                await new Promise((r) => setTimeout(r, 50));
            }
        }
        throw unavailable('the process did not exit');
    }
    async startSession(agent, live) {
        const adapter = this.adapters.create(agent.profile);
        const id = randomUUID();
        this.db
            .prepare('INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at) VALUES (?, ?, ?)')
            .run(id, agent.id, Date.now());
        this.db
            .prepare('UPDATE agents SET current_session_id = ? WHERE id = ?')
            .run(id, agent.id);
        agent.currentSessionId = id;
        let session;
        try {
            session = await this.daemon.start({
                id,
                profile: agent.profile,
                args: adapter.startArgs({ resume: agent.vendorConversationId }),
                cwd: agent.cwd,
                label: `${LABEL_PREFIX}${agent.id}`,
            });
        }
        catch (err) {
            if (err instanceof DaemonError && err.code === 'disconnected') {
                this.setState(agent, live, 'exited', null);
                throw err;
            }
            this.db
                .prepare('DELETE FROM agent_sessions WHERE daemon_session_id = ?')
                .run(id);
            this.db
                .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ? AND current_session_id = ?')
                .run(agent.id, id);
            agent.currentSessionId = null;
            throw err;
        }
        const sl = this.trackSession(agent, live, session.id, adapter);
        this.appendItem(agent.id, live, session.id, 0, {
            kind: 'system',
            text: agent.vendorConversationId
                ? `session resumed (${session.id})`
                : `session started (${session.id})`,
        });
        sl.startedBoundary = true;
        this.setState(agent, live, adapter.initialState ?? 'starting', null);
        this.emit('session', agent.id, {
            daemonSessionId: session.id,
            startedAt: session.startedAt,
            endedAt: null,
        });
        await this.attachSession(agent, live, sl);
        await this.reconcileCurrent(agent, live);
    }
    trackSession(agent, live, sessionId, adapter) {
        let sl = live.sessions.get(sessionId);
        if (!sl) {
            sl = {
                id: sessionId,
                adapter,
                lastSeq: 0,
                replayed: false,
                complete: false,
                attaching: false,
                pendingExit: null,
                pendingBoundary: null,
                suspended: false,
                startedBoundary: false,
                endedBoundary: false,
                keys: new Map(),
            };
            live.sessions.set(sessionId, sl);
        }
        this.sessionOwner.set(sessionId, agent.id);
        return sl;
    }
    async attachSession(agent, live, sl) {
        sl.attaching = true;
        sl.suspended = false;
        try {
            await this.daemon.attach(sl.id, sl.lastSeq + 1);
            sl.replayed = true;
            sl.complete = true;
        }
        catch (err) {
            sl.replayed = false;
            sl.complete = false;
            this.logger.warn(`replay of ${sl.id} for agent ${agent.id} failed: ${err.message}`);
            this.appendItem(agent.id, live, sl.id, 0, {
                kind: 'system',
                text: `history unavailable: ${err.message}`,
            });
        }
        finally {
            sl.attaching = false;
        }
        if (sl.pendingExit && sl.replayed) {
            const s = sl.pendingExit;
            sl.pendingExit = null;
            this.applyExit(agent, live, s);
        }
        if (sl.pendingBoundary && sl.complete) {
            const s = sl.pendingBoundary;
            sl.pendingBoundary = null;
            this.endBoundary(agent, live, sl, s);
        }
    }
    endBoundary(agent, live, sl, session) {
        if (sl.endedBoundary)
            return;
        if (!sl.complete || sl.attaching) {
            sl.pendingBoundary = session;
            return;
        }
        this.appendItem(agent.id, live, session.id, 0, {
            kind: 'system',
            text: `session ended${exitWhy(session)}`,
        });
        sl.endedBoundary = true;
    }
    reconcileTurnState(agent, live, sl) {
        const open = sl.adapter.turnInProgress?.();
        if (open === undefined)
            return;
        if (live.status.state === 'working' && !open)
            this.setState(agent, live, 'idle', null);
        if (live.status.state === 'idle' && open)
            this.setState(agent, live, 'working', null);
    }
    async reconcileCurrent(agent, live) {
        const fresh = this.find(agent.id);
        if (!fresh?.currentSessionId)
            return;
        agent.currentSessionId = fresh.currentSessionId;
        try {
            const s = await this.daemon.getSession(fresh.currentSessionId);
            if (s.state === 'exited')
                this.applyExit(agent, live, s);
        }
        catch (err) {
            if (err instanceof DaemonError && err.code === 'unknown-session') {
                this.applyExit(agent, live, {
                    id: fresh.currentSessionId,
                    state: 'exited',
                    exitReason: 'removed',
                    exitCode: null,
                    signal: null,
                    exitedAt: Date.now(),
                    startedAt: 0,
                    lastSeq: 0,
                });
            }
        }
    }
    onOutput(sessionId, record) {
        const agentId = this.sessionOwner.get(sessionId);
        if (!agentId)
            return;
        const live = this.live.get(agentId);
        const sl = live?.sessions.get(sessionId);
        if (!live || !sl || sl.suspended)
            return;
        if (record.seq <= sl.lastSeq)
            return;
        sl.lastSeq = record.seq;
        const agent = this.find(agentId);
        if (!agent)
            return;
        this.apply(agent, live, sl, record, sl.adapter.ingest(record));
    }
    apply(agent, live, sl, record, ingest) {
        if (ingest.conversationId &&
            ingest.conversationId !== agent.vendorConversationId) {
            this.db
                .prepare('UPDATE agents SET vendor_conversation_id = ? WHERE id = ?')
                .run(ingest.conversationId, agent.id);
            agent.vendorConversationId = ingest.conversationId;
        }
        for (const op of ingest.ops ?? [])
            this.applyOp(agent.id, live, sl, record.seq, op);
        if (ingest.state && sl.id === agent.currentSessionId)
            this.setState(agent, live, ingest.state, ingest.error ?? null);
    }
    applyOp(agentId, live, sl, seq, op) {
        if (op.op === 'update') {
            const index = sl.keys.get(op.key);
            if (index !== undefined) {
                const stored = live.items[index];
                stored.item = op.item;
                stored.seqTo = seq;
                live.status.lastActivityAt = Date.now();
                this.emit('item', agentId, stored);
                return;
            }
        }
        const stored = this.appendItem(agentId, live, sl.id, seq, op.item);
        if (op.key)
            sl.keys.set(op.key, stored.index);
    }
    onSessionChanged(session) {
        if (session.state !== 'exited')
            return;
        const agentId = this.sessionOwner.get(session.id) ??
            (session.label?.startsWith(LABEL_PREFIX)
                ? session.label.slice(LABEL_PREFIX.length)
                : undefined);
        if (!agentId)
            return;
        const agent = this.find(agentId);
        if (!agent)
            return;
        const live = this.ensureLive(agent);
        const sl = live.sessions.get(session.id) ??
            this.trackSession(agent, live, session.id, this.adapters.create(agent.profile));
        if (sl.attaching || !sl.replayed) {
            sl.pendingExit = session;
            return;
        }
        this.applyExit(agent, live, session);
    }
    applyExit(agent, live, session) {
        this.db
            .prepare('UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ? AND ended_at IS NULL')
            .run(session.exitedAt ?? Date.now(), session.id);
        const cleared = this.db
            .prepare('UPDATE agents SET current_session_id = NULL WHERE id = ? AND current_session_id = ?')
            .run(agent.id, session.id).changes;
        if (cleared === 0)
            return;
        agent.currentSessionId = null;
        const sl = live.sessions.get(session.id) ??
            this.trackSession(agent, live, session.id, this.adapters.create(agent.profile));
        this.endBoundary(agent, live, sl, session);
        this.setState(agent, live, 'exited', null);
        this.emit('session', agent.id, {
            daemonSessionId: session.id,
            startedAt: session.startedAt,
            endedAt: session.exitedAt,
        });
    }
    scheduleResync() {
        const generation = ++this.resyncGeneration;
        for (const { id } of this.db.prepare('SELECT id FROM agents').all()) {
            const agent = this.find(id);
            if (agent)
                this.gate(this.ensureLive(agent));
        }
        this.resyncChain = this.resyncChain
            .then(() => this.resync(generation))
            .catch((err) => this.logger.error(`resync failed: ${err.message}`))
            .finally(() => {
            if (generation === this.resyncGeneration)
                for (const live of this.live.values())
                    live.markSynced();
        });
    }
    gate(live) {
        if (live.syncPending)
            return;
        const d = deferred();
        live.syncPending = true;
        live.synced = d.promise;
        live.markSynced = () => {
            live.syncPending = false;
            d.resolve();
        };
    }
    onDaemonLost() {
        for (const live of this.live.values()) {
            for (const sl of live.sessions.values())
                sl.replayed = false;
            this.gate(live);
        }
    }
    async resync(generation) {
        const ids = this.db.prepare('SELECT id FROM agents').all().map((r) => r.id);
        let done = 0;
        for (const id of ids) {
            if (generation !== this.resyncGeneration)
                return;
            const stale = this.find(id);
            if (!stale)
                continue;
            const live = this.ensureLive(stale);
            await this.withLock(live, async () => {
                const agent = this.find(id);
                if (!agent || generation !== this.resyncGeneration)
                    return;
                const sessions = await this.daemon.listSessions();
                const byId = new Map(sessions.map((s) => [s.id, s]));
                this.adoptSessions(agent, sessions);
                let refs = this.sessions(agent.id);
                const failedEarlier = refs.some((ref, i) => i < refs.length - 1 &&
                    live.sessions.get(ref.daemonSessionId)?.complete === false);
                if (failedEarlier && live.items.length > 0) {
                    this.logger.log(`agent ${agent.id}: rebuilding transcript so recovered history keeps its order`);
                    live.items = [];
                    for (const sl of live.sessions.values()) {
                        sl.lastSeq = 0;
                        sl.replayed = false;
                        sl.complete = false;
                        sl.suspended = true;
                        sl.startedBoundary = false;
                        sl.endedBoundary = false;
                        sl.keys.clear();
                        sl.adapter = this.adapters.create(agent.profile);
                    }
                    this.emit('reset', agent.id);
                }
                refs = this.sessions(agent.id);
                for (const [i, ref] of refs.entries()) {
                    if (generation !== this.resyncGeneration)
                        return;
                    const s = byId.get(ref.daemonSessionId);
                    if (!s)
                        continue;
                    const sl = this.trackSession(agent, live, s.id, live.sessions.get(s.id)?.adapter ??
                        this.adapters.create(agent.profile));
                    if (!sl.startedBoundary) {
                        this.appendItem(agent.id, live, s.id, 0, {
                            kind: 'system',
                            text: `${i === 0 ? 'session started' : 'session resumed'} (${s.id})`,
                        });
                        sl.startedBoundary = true;
                    }
                    const isCurrent = s.id === agent.currentSessionId;
                    if (isCurrent &&
                        s.state === 'running' &&
                        live.status.state === 'starting') {
                        this.setState(agent, live, sl.adapter.initialState ?? 'starting', null);
                    }
                    if (!sl.replayed ||
                        sl.lastSeq < s.lastSeq ||
                        (isCurrent && s.state === 'running')) {
                        await this.attachSession(agent, live, sl);
                        if (isCurrent && s.state === 'running')
                            this.reconcileTurnState(agent, live, sl);
                    }
                    if (s.state === 'exited' && !sl.pendingExit) {
                        if (isCurrent)
                            this.applyExit(agent, live, s);
                        else
                            this.endBoundary(agent, live, sl, s);
                        if (ref.endedAt === null)
                            this.db
                                .prepare('UPDATE agent_sessions SET ended_at = ? WHERE daemon_session_id = ?')
                                .run(s.exitedAt ?? Date.now(), s.id);
                    }
                }
                await this.reconcileCurrent(agent, live);
                const fresh = this.find(agent.id);
                if (fresh && !fresh.currentSessionId && live.status.state !== 'exited')
                    this.setState(agent, live, 'exited', null);
                live.markSynced();
            });
            done++;
        }
        this.logger.log(`resynced ${done} agent(s)`);
    }
    adoptSessions(agent, sessions) {
        const known = new Set(this.sessions(agent.id).map((r) => r.daemonSessionId));
        const mine = sessions
            .filter((s) => s.label === `${LABEL_PREFIX}${agent.id}`)
            .sort((a, b) => a.startedAt - b.startedAt);
        for (const s of mine) {
            if (known.has(s.id))
                continue;
            this.db
                .prepare('INSERT INTO agent_sessions (daemon_session_id, agent_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
                .run(s.id, agent.id, s.startedAt, s.exitedAt);
            this.logger.log(`adopted daemon session ${s.id} for agent ${agent.id}`);
        }
        if (!agent.currentSessionId) {
            const running = mine.filter((s) => s.state === 'running');
            if (running.length) {
                const current = running[running.length - 1];
                this.db
                    .prepare('UPDATE agents SET current_session_id = ? WHERE id = ? AND current_session_id IS NULL')
                    .run(current.id, agent.id);
                agent.currentSessionId = this.find(agent.id)?.currentSessionId ?? null;
                for (const extra of running.slice(0, -1)) {
                    this.logger.warn(`agent ${agent.id} has a second live session ${extra.id}; ending it`);
                    void this.daemon.endInput(extra.id).catch(() => undefined);
                }
            }
        }
    }
    ensureLive(agent) {
        let live = this.live.get(agent.id);
        if (!live) {
            live = {
                sessions: new Map(),
                status: {
                    state: agent.currentSessionId ? 'starting' : 'exited',
                    error: null,
                    lastActivityAt: agent.createdAt,
                },
                items: [],
                lock: Promise.resolve(),
                synced: Promise.resolve(),
                markSynced: () => undefined,
                syncPending: false,
            };
            this.live.set(agent.id, live);
        }
        return live;
    }
    withLock(live, fn) {
        const run = live.lock.then(fn, fn);
        live.lock = run.catch(() => undefined);
        return run;
    }
    async withLockOrForce(live, agentId, fn) {
        await Promise.race([
            live.synced,
            new Promise((r) => setTimeout(r, LOCK_PATIENCE_MS)),
        ]);
        let acquired = false;
        const run = this.withLock(live, () => {
            acquired = true;
            return fn();
        });
        const settled = run.then(() => true, () => true);
        for (const [signal, wait] of [
            ['SIGTERM', LOCK_PATIENCE_MS],
            ['SIGKILL', LOCK_PATIENCE_MS + 1000],
        ]) {
            const free = await Promise.race([
                settled,
                new Promise((r) => setTimeout(() => r(false), wait)),
            ]);
            if (free || acquired)
                break;
            const sid = this.find(agentId)?.currentSessionId;
            if (!sid)
                break;
            this.logger.warn(`agent ${agentId}: a command is blocked; sending ${signal} to free it`);
            await this.daemon.signal(sid, signal).catch(() => undefined);
        }
        return run;
    }
    async awaitStarting(live) {
        const until = Date.now() + STARTING_GRACE_MS;
        while (live.status.state === 'starting' && Date.now() < until)
            await new Promise((r) => setTimeout(r, 25));
    }
    appendItem(agentId, live, sessionId, seq, item) {
        const stored = {
            index: live.items.length,
            sessionId,
            seqFrom: seq,
            seqTo: seq,
            item,
        };
        live.items.push(stored);
        live.status.lastActivityAt = Date.now();
        this.emit('item', agentId, stored);
        return stored;
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