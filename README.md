# prisma-generator-flavoured-ids

[![npm](https://img.shields.io/npm/v/prisma-generator-flavoured-ids.svg)](https://www.npmjs.com/package/prisma-generator-flavoured-ids)

This generator intends to mitigate the issue with weakly-typed ID's on Prisma Schema entities.

## Motivation

The following Prisma Schema:

```prisma
model User {
  id    String  @id @default(uuid())
  name  String
  email String? @unique

  Blogposts Blogpost[]
}

model Blogpost {
  id String @id @default(cuid())

  content String

  // Empty Author means KGG authored the blogpost
  Author   User?   @relation(fields: [authorId], references: [id])
  authorId String?
}
```

will generate the model and methods related to user with `id` being of type `string`. This is not ideal, as it is easy to pass a wrong type of ID to the generated methods, e.g.:

```typescript
// The called of the method passes `userId`
const deleteBlogpostsForUser = async (id: string) => {
  // From within the method, typescript doesn't prevent from using `userId` as a `blogpostId`
  await prisma.blogpost.deleteMany({
    where: { id },
  });
}
```

[A related Prisma issue](https://github.com/prisma/prisma/issues/9853)

To resolve the problem, the generator will overwrite the resulting schema with the following:

1. Add a branded type for each model ID, e.g.

```typescript
export interface Flavoring<FlavorT> {
  _type?: FlavorT
}
export type Flavor<T, FlavorT> = T & Flavoring<FlavorT>

export type UserId = Flavor<string, 'UserId'>
```

2. Change the methods to use the branded type, e.g.

```typescript
export type UserWhereUniqueInput = Prisma.AtLeast<{
  id?: UserId
  /// ...
}>

export type UserWhereInput = Prisma.AtLeast<{
  id?: StringFilter<"User"> | UserId
  /// ...
}>

// and others
```

In result, the example from above will be prevented by typescript:

```typescript
import { UserId } from '@prisma/client'

const deleteBlogpostsForUser = async (id: UserId) => {
  await prisma.blogpost.deleteMany({
    // Typescript will show an error here
    where: { id },
  });
}
```

### Disclaimer

1. Ideally, Prisma needs to add a native support for branded types. If you find this solution useful, please up-vote the [Prisma issue](https://github.com/prisma/prisma/issues/9853)

2. This is a dirty approach, as it relies on the generated code. This library has been used for several months and had to be changed significantly based on the changes Prisma made to their client

## Installation

```sh
# inside your project's working tree
npm i prisma-generator-flavoured-ids
```

```prisma
generator flavoured_ids {
  provider = "prisma-generator-flavoured-ids"
  // A path to the generated client - can vary on your setup
  output   = "node_modules/.prisma/client/index.d.ts"
}
```