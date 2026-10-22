import { Body, Controller, Param, Post } from '@nestjs/common';
import { ExecResult, ExecService } from './exec.service.js';

/** One command on a host (this machine or a spoke), in the session its daemon runs in. */
@Controller('api/hosts/:name/exec')
export class ExecController {
  constructor(private readonly exec: ExecService) {}

  @Post()
  run(
    @Param('name') name: string,
    @Body() body: { command?: unknown; cwd?: unknown; timeoutMs?: unknown },
  ): Promise<ExecResult> {
    return this.exec.run(name, body ?? {});
  }
}
