var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Injectable, NotFoundException } from '@nestjs/common';
import { claudeAdapterFactory } from './claude.adapter.js';
import { fakeAdapterFactory } from './fake.adapter.js';
let AdaptersService = class AdaptersService {
    factories = new Map([
        [claudeAdapterFactory.profile, claudeAdapterFactory],
        [fakeAdapterFactory.profile, fakeAdapterFactory],
    ]);
    supports(profile) {
        return this.factories.has(profile);
    }
    create(profile) {
        const f = this.factories.get(profile);
        if (!f)
            throw new NotFoundException(`no adapter for profile "${profile}"`);
        return f.create();
    }
    profiles() {
        return [...this.factories.keys()];
    }
};
AdaptersService = __decorate([
    Injectable()
], AdaptersService);
export { AdaptersService };
//# sourceMappingURL=adapters.service.js.map