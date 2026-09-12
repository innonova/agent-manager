var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Controller, Get } from '@nestjs/common';
import { AdaptersService } from './adapters/adapters.service.js';
import { DaemonClient } from './daemon/daemon-client.js';
let ProfilesController = class ProfilesController {
    daemon;
    adapters;
    constructor(daemon, adapters) {
        this.daemon = daemon;
        this.adapters = adapters;
    }
    async list() {
        const profiles = await this.daemon.listProfiles();
        return {
            profiles: profiles.map((p) => ({
                ...p,
                supported: this.adapters.supports(p.name),
            })),
        };
    }
};
__decorate([
    Get(),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], ProfilesController.prototype, "list", null);
ProfilesController = __decorate([
    Controller('api/profiles'),
    __metadata("design:paramtypes", [DaemonClient,
        AdaptersService])
], ProfilesController);
export { ProfilesController };
//# sourceMappingURL=profiles.controller.js.map