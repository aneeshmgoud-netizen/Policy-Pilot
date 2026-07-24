import { Module } from '@nestjs/common';
import { EntitlementLookupService } from './entitlement-lookup.service';

@Module({
  providers: [EntitlementLookupService],
  exports: [EntitlementLookupService],
})
export class EntitlementsModule {}
