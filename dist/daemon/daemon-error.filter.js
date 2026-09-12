var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
import { Catch } from '@nestjs/common';
import { DaemonError } from './daemon-client.js';
let DaemonErrorFilter = class DaemonErrorFilter {
    catch(err, host) {
        const res = host.switchToHttp().getResponse();
        res.status(503).json({
            statusCode: 503,
            code: 'agent-unavailable',
            daemonCode: err.code,
            message: `agent unavailable: ${err.message}`,
        });
    }
};
DaemonErrorFilter = __decorate([
    Catch(DaemonError)
], DaemonErrorFilter);
export { DaemonErrorFilter };
//# sourceMappingURL=daemon-error.filter.js.map