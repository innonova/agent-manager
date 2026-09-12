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
import { Body, Controller, Delete, Get, Param, Patch, Post, } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service.js';
import { ProjectsService } from './projects.service.js';
let ProjectsController = class ProjectsController {
    projects;
    agents;
    constructor(projects, agents) {
        this.projects = projects;
        this.agents = agents;
    }
    list() {
        return this.projects.list().map((project) => ({
            project,
            agentCounts: this.agents.counts(project.id),
        }));
    }
    create(body) {
        const project = this.projects.create(body);
        return { project, agentCounts: this.agents.counts(project.id) };
    }
    get(id) {
        return {
            project: this.projects.get(id),
            agentCounts: this.agents.counts(id),
        };
    }
    update(id, body) {
        return { project: this.projects.update(id, body) };
    }
    async remove(id) {
        this.projects.get(id);
        await this.agents.removeProject(id);
        try {
            this.projects.remove(id);
        }
        finally {
            this.agents.releaseProject(id);
        }
        return { ok: true };
    }
};
__decorate([
    Get(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Array)
], ProjectsController.prototype, "list", null);
__decorate([
    Post(),
    __param(0, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Object)
], ProjectsController.prototype, "create", null);
__decorate([
    Get(':id'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Object)
], ProjectsController.prototype, "get", null);
__decorate([
    Patch(':id'),
    __param(0, Param('id')),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Object)
], ProjectsController.prototype, "update", null);
__decorate([
    Delete(':id'),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], ProjectsController.prototype, "remove", null);
ProjectsController = __decorate([
    Controller('api/projects'),
    __metadata("design:paramtypes", [ProjectsService,
        AgentsService])
], ProjectsController);
export { ProjectsController };
//# sourceMappingURL=projects.controller.js.map