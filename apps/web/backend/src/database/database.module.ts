import { Global, Module } from "@nestjs/common";
import { createRepositories, getPrismaClient, type Repositories } from "@shopify-decathlon/database";

export const REPOSITORIES = Symbol("REPOSITORIES");

@Global()
@Module({
  providers: [
    {
      provide: REPOSITORIES,
      useFactory: (): Repositories => createRepositories(getPrismaClient()),
    },
  ],
  exports: [REPOSITORIES],
})
export class DatabaseModule {}
