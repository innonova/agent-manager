var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var ConfigModule_1;
import { Global, Module } from '@nestjs/common';
import { MANAGER_CONFIG, loadConfig } from './config.js';
let ConfigModule = ConfigModule_1 = class ConfigModule {
    static forRoot(overrides = {}) {
        const config = { ...loadConfig(), ...overrides };
        return {
            module: ConfigModule_1,
            providers: [{ provide: MANAGER_CONFIG, useValue: config }],
            exports: [MANAGER_CONFIG],
        };
    }
};
ConfigModule = ConfigModule_1 = __decorate([
    Global(),
    Module({})
], ConfigModule);
export { ConfigModule };
//# sourceMappingURL=config.module.js.map