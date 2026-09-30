import { Module } from '@nestjs/common';

import { KavachModule } from './kavach/kavach.module';

@Module({
  imports: [KavachModule],
})
export class AppModule {}
