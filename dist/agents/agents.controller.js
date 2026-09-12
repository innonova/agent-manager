var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
import { Body, Controller, Get, HttpCode, Param, Post, Query, } from '@nestjs/common';
import { AgentsService, } from './agents.service.js';
let AgentsController = class AgentsController {
    agents;
    constructor(agents) {
        this.agents = agents;
    }
    list(projectId) {
        return this.agents.list(projectId);
    }
    create(projectId, body) {
        return this.agents.create(projectId, body);
    }
    get(id) {
        return {
            agent: this.agents.get(id),
            status: this.agents.status(id),
            sessions: this.agents.sessions(id),
        };
    }
    items(id, from) {
        return { items: this.agents.items(id, from ? Number(from) : 0) };
    }
    async turn(id, body) {
        await this.agents.turn(id, body?.text);
        return { ok: true };
    }
    async interrupt(id) {
        await this.agents.interrupt(id);
        return { ok: true };
    }
    async stop(id) {
        await this.agents.stop(id);
        return { ok: true };
    }
    async archive(id) {
        await this.agents.archive(id);
        return { ok: true };
    }
};
__decorate([
    Get('projects/:projectId/agents'),
    __param(0, Param('projectId')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Array)
], AgentsController.prototype, "list", null);
__decorate([
    Post('projects/:projectId/agents'),
    __param(0, Param('projectId')),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "create", null);
__decorate([
    Get('agents/:id'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Object)
], AgentsController.prototype, "get", null);
__decorate([
    Get('agents/:id/items'),
    __param(0, Param('id')),
    __param(1, Query('from')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Object)
], AgentsController.prototype, "items", null);
__decorate([
    Post('agents/:id/turn'),
    HttpCode(202),
    __param(0, Param('id')),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "turn", null);
__decorate([
    Post('agents/:id/interrupt'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "interrupt", null);
__decorate([
    Post('agents/:id/stop'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "stop", null);
__decorate([
    Post('agents/:id/archive'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], AgentsController.prototype, "archive", null);
AgentsController = __decorate([
    Controller('api'),
    __metadata("design:paramtypes", [AgentsService])
], AgentsController);
export { AgentsController };
//# sourceMappingURL=agents.controller.js.map