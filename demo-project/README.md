# DB-Scope Demo Project

A realistic e-commerce codebase designed to exercise every feature of the **DB-Scope** VS Code extension.

---

## 📁 Structure

```
demo-project/
├── migrations/
│   ├── 001_initial_schema.sql       # Creates users + products
│   ├── 002_add_orders.sql           # Adds orders, order_items, indexes
│   ├── 003_risky_drop_phone.sql     # ⚠️  HIGH-RISK migration (for demo)
│   └── 004_sessions_audit.sql       # Adds sessions + audit_log
├── schemas/
│   ├── schema_a.sql                 # Production snapshot (Schema A for Merge)
│   └── schema_b.sql                 # Staging snapshot  (Schema B for Merge)
└── src/
    ├── userService.ts               # queries users.phone × 3
    ├── notificationService.ts       # queries users.phone × 2
    ├── profileController.ts         # queries users.phone × 3
    ├── orderService.ts              # orders, order_items, products, audit_log
    └── analytics.py                 # Python: phone-based SMS segments
```

---

## 🧪 Feature Demos

### 1 · Real-Time SQL Diagnostics

Open any migration file and watch DB-Scope flag dangerous queries with red squiggles.

| File | Query | Expected Warning |
|------|-------|-----------------|
| `migrations/003_risky_drop_phone.sql` | `ALTER TABLE users DROP COLUMN phone` | HIGH-RISK breaking change |
| `migrations/003_risky_drop_phone.sql` | `DELETE FROM sessions` | DELETE without WHERE |
| `migrations/003_risky_drop_phone.sql` | `TRUNCATE audit_log` | TRUNCATE destroys all rows |
| `src/orderService.ts` | `DELETE FROM order_items` | DELETE without WHERE |

---

### 2 · Hover Tooltips (Impact Analysis)

Open `migrations/003_risky_drop_phone.sql` and **hover over**:

```sql
ALTER TABLE users DROP COLUMN phone;
```

Expected hover card:
- **Risk Score**: 9/10 CRITICAL
- **App Dependencies**: 3 files (userService.ts, notificationService.ts, profileController.ts)
- **Cascade Effects**: notificationService SMS dispatch will fail
- **Suggested Rollback**: `ALTER TABLE users ADD COLUMN phone VARCHAR(20);`

---

### 3 · Full Impact Analysis Report

1. Open `migrations/003_risky_drop_phone.sql`
2. Right-click → **DB-Scope: Analyze Migration Impact**  
   *or* `Ctrl+Shift+P` → `DB-Scope: Analyze Migration Impact`

Expected report sections:
- **Schema Impact**: 1 breaking change (DROP COLUMN)
- **App Dependencies**: 8 references across 3 `.ts` files + 1 `.py` file
- **Data Integrity Risks**: Cascading NULL if column removed without backfill
- **Documentation Drift**: Check README/API docs for `phone` field

---

### 4 · Duplicate Detector

Run `Ctrl+Shift+P` → **DB-Scope: Detect Logical Duplicates in Schema**  
Point it at `schemas/schema_a.sql`.

Expected duplicates detected:
| Column A | Column B | Reason |
|----------|----------|--------|
| `fname` | `first_name` | Semantic synonym (abbreviation) |
| `email` | `email_address` | Semantic synonym |
| `phone` | `mobile` | Semantic synonym |

---

### 5 · Merge Conflict Analyzer

Run `Ctrl+Shift+P` → **DB-Scope: Analyze Database Merge Conflicts**

- **Schema A**: select `schemas/schema_a.sql`
- **Schema B**: select `schemas/schema_b.sql`

Expected conflicts:
| Table | Conflict | Detail |
|-------|----------|--------|
| `users` | Column type mismatch | `first_name`: VARCHAR(50) vs VARCHAR(100) |
| `users` | Missing columns in B | `fname`, `email_address`, `mobile`, `updated_at`, `deleted_at` |
| `users` | Missing columns in A | `last_name`, `is_verified` |
| `orders` | Type mismatch | `status`: VARCHAR(20) vs VARCHAR(30), `total_amount`: DECIMAL(12,2) vs DECIMAL(14,2) |
| `orders` | Missing columns in A | `discount`, `fulfilled_at` |
| `order_items` | Column renamed | `quantity` (A) vs `qty` (B) |
| `order_items` | FK constraint diff | `ON DELETE CASCADE` present in A, absent in B |
| `products` | Missing columns in A | `sale_price`, `is_active` |
| `inventory` | Table missing in A | Entire table exists only in B |
| `sessions` | Table missing in B | Entire table exists only in A |
| `audit_log` | Table missing in B | Entire table exists only in A |

---

### 6 · Dashboard

Click `$(database) DB-Scope` in the status bar or run `Ctrl+Shift+P` → **DB-Scope: Open Dashboard**.

Explore tabs:
- **Overview** — live table/column counts
- **Impact Analysis** — colour-coded risk scores
- **Merge Analysis** — conflict resolution view
- **Duplicates** — grouped duplicate results
- **Timeline** — schema evolution history

---

## ⚙️ Setup (for live DB connection)

If you have a local PostgreSQL instance you can load the demo schema:

```bash
# Create a demo database
createdb myapp_demo

# Run migrations in order
psql -d myapp_demo -f migrations/001_initial_schema.sql
psql -d myapp_demo -f migrations/002_add_orders.sql
psql -d myapp_demo -f migrations/004_sessions_audit.sql
# Skip 003 — that's the risky one DB-Scope will analyse

# Configure DB-Scope
# VS Code → Settings → DB-Scope:
#   connectionString:  postgresql://localhost/myapp_demo
#   dbType:            postgresql
```

> **Note:** A live DB connection is optional. DB-Scope's static analysis (diagnostics, duplicate detection, merge conflicts) works without any connection.

---

## 🎯 Quick-Start Checklist

- [ ] Open `migrations/003_risky_drop_phone.sql` — see red squiggles immediately
- [ ] Hover over `ALTER TABLE users DROP COLUMN phone` — see impact card
- [ ] Right-click the same line → Analyze Migration Impact
- [ ] Open `schemas/schema_a.sql` → detect duplicates
- [ ] Run merge conflict analysis: schema_a.sql vs schema_b.sql
- [ ] Open the DB-Scope Dashboard from the status bar
