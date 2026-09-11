# AWS RDS PostgreSQL migration guide

This prototype currently stores data in SQLite. For AWS production, move the application database to Amazon RDS PostgreSQL. Do not expose PostgreSQL publicly.

## 1. Create the RDS database

In AWS, create an RDS PostgreSQL instance in the same VPC/region as the application server. Prefer private subnets for production.

Recommended security rule:

- PostgreSQL port: `5432`
- Source: the EC2 application server security group only
- Do not use `0.0.0.0/0` for port 5432

## 2. Get the connection values

Record:

- DB host
- Port
- Database name
- Username
- Password

Example environment values for the future PostgreSQL build:

```env
DB_HOST=your-rds-endpoint
DB_PORT=5432
DB_NAME=rewardtree
DB_USER=rewardtree_app
DB_PASSWORD=change-me
```

## 3. Important: this SQLite build is not PostgreSQL-ready by changing one variable

The current prototype uses Node's built-in SQLite API. Moving to RDS requires changing the database layer to PostgreSQL (for example with `pg` or Prisma) and running a schema/data migration. Keep business logic separate from SQL so this change is isolated.

## 4. Migration order

1. Freeze new writes to the SQLite database.
2. Export/transform the SQLite data.
3. Create the PostgreSQL schema.
4. Import users, referrals, memberships, payment submissions, rewards, products and audit logs.
5. Verify row counts and relationships.
6. Point the application at PostgreSQL.
7. Test login, referral verification, payment approval and Auto Pool placement.
8. Keep the SQLite file as a rollback backup until the PostgreSQL deployment is stable.

## 5. Application networking

EC2 → private RDS

The application server should connect using the RDS endpoint on port 5432. Do not expose the database directly to the internet.
