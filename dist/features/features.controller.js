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
import { Body, Controller, Get, HttpCode, Param, Patch, Post, } from '@nestjs/common';
import { FeaturesService } from './features.service.js';
let FeaturesController = class FeaturesController {
    features;
    constructor(features) {
        this.features = features;
    }
    async list(id) {
        return { features: await this.features.list(id) };
    }
    async create(id, body) {
        return { feature: await this.features.create(id, body) };
    }
    async get(id, slug) {
        return { feature: await this.features.get(id, slug) };
    }
    async patch(id, slug, body) {
        return { feature: await this.features.setStatus(id, slug, body?.status) };
    }
    async queue(id, slug, body) {
        return { feature: await this.features.queue(id, slug, body ?? {}) };
    }
    async dequeue(id, slug) {
        return { feature: await this.features.dequeue(id, slug) };
    }
};
__decorate([
    Get(),
    __param(0, Param('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "list", null);
__decorate([
    Post(),
    __param(0, Param('id')),
    __param(1, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "create", null);
__decorate([
    Get(':slug'),
    __param(0, Param('id')),
    __param(1, Param('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "get", null);
__decorate([
    Patch(':slug'),
    __param(0, Param('id')),
    __param(1, Param('slug')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "patch", null);
__decorate([
    Post(':slug/queue'),
    HttpCode(202),
    __param(0, Param('id')),
    __param(1, Param('slug')),
    __param(2, Body()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "queue", null);
__decorate([
    Post(':slug/dequeue'),
    __param(0, Param('id')),
    __param(1, Param('slug')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], FeaturesController.prototype, "dequeue", null);
FeaturesController = __decorate([
    Controller('api/projects/:id/features'),
    __metadata("design:paramtypes", [FeaturesService])
], FeaturesController);
export { FeaturesController };
//# sourceMappingURL=features.controller.js.map