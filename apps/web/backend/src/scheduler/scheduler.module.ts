import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { QueueProducerService } from "./queue-producer.service";
import { OrderImportSchedulerService } from "./order-import-scheduler.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [QueueProducerService, OrderImportSchedulerService],
  exports: [QueueProducerService, OrderImportSchedulerService],
})
export class SchedulerModule {}
