# DocCertified

A web and mobile app concept that helps companies verify certified, up-to-date documentation automatically, removing manual checks and the human error that comes with them.

This repo holds a **single-file rapid prototype** (`doccertified.js`). Once it meets the standard, each part moves into its target technology.

## Run it

Requires Node 18+. No npm packages needed.

```bash
node doccertified.js        # open http://localhost:3000
node doccertified.js --sql  # print the Supabase/PostgreSQL schema
```

## What the prototype does

- Tracks employees and vendors against required-document lists
- Stores uploaded documents with a SHA-256 hash for tamper detection
- Runs a **simulated** issuer-registry check (format and revoked list only)
- Classes documents as valid, expiring, expired, invalid or missing
- Scans every minute and raises or clears alerts
- React dashboard with compliance matrix, alerts and audit log

## Not done yet

- Reading details (issuer, number, dates) automatically from the uploaded file
- Real issuer-registry integrations
- Authentication and per-company data isolation

## Target stack

React, PostgreSQL on Supabase, deployed on Render, developed in VS Code.

## Credits

Made by VoidClient02 with help from Claude (Anthropic).
