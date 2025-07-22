# Database Adapter

PostgreSQL database adapter for Mark using dbmate for migrations and zapatos for type-safe queries.

## Setup

1. **Environment Configuration**
   Configure your database connection through environment variables at the project root or in your deployment configuration:
   ```bash
   export DATABASE_URL="postgresql://user:password@localhost:5432/mark_dev?sslmode=disable"
   export TEST_DATABASE_URL="postgresql://user:password@localhost:5432/mark_test?sslmode=disable"
   ```

2. **Install Dependencies**
   ```bash
   yarn install
   ```

3. **Database Operations**

   From the project root, use workspace commands:
   ```bash
   # Set database URL
   export DATABASE_URL=postgres://postgres:qwerty@localhost:5432/mark_db?sslmode=disable

   # Create database
   yarn workspace @mark/database db:create

   # Run migrations
   yarn workspace @mark/database db:migrate

   # Check migration status
   yarn workspace @mark/database db:status

   # Create new migration
   yarn workspace @mark/database db:new migration_name

   # Rollback last migration
   yarn workspace @mark/database db:rollback

   # Generate TypeScript types from schema
   yarn workspace @mark/database db:generate-types
   ```

   Or from within the database adapter directory:
   ```bash
   # Set database URL
   export DATABASE_URL=postgres://postgres:qwerty@localhost:5432/mark_db?sslmode=disable

   # Run migrations
   yarn db:migrate

   # Create new migration
   yarn db:new migration_name

   # Check migration status
   yarn db:status

   # Rollback last migration
   yarn db:rollback
   ```

## Structure

- `src/` - Source TypeScript files
- `test/` - Test files
- `db/` - Database schema and migrations
  - `migrations/` - dbmate migration files
  - `schema.sql` - Complete database schema

## Usage

```typescript
import { initializeDatabase, getPool } from '@mark/database';

// Initialize database connection
const pool = initializeDatabase({
  connectionString: process.env.DATABASE_URL!,
});

// Use the pool for queries (zapatos types will be generated)
const result = await pool.query('SELECT * FROM earmarks');
```

## Development

```bash
# Build
yarn build

# Test
yarn test

# Lint
yarn lint
```
