import { Logger, Module } from '@nestjs/common';

import { createBackend } from './backends/backend.factory';
import { KAVACH_BACKEND } from './backends/backend.interface';
import { KavachController } from './kavach.controller';
import { KavachOrchestrator } from './orchestrator.service';

@Module({
  controllers: [KavachController],
  providers: [
    { provide: KAVACH_BACKEND, useFactory: () => createBackend(undefined, new Logger('Kavach')) },
    KavachOrchestrator,
  ],
  exports: [KavachOrchestrator, KAVACH_BACKEND],
})
export class KavachModule {}
