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

- Tracks employees, vendors and contractors against required-document lists
- Reads uploaded PDFs, photos and scans in the browser (PDF text or OCR) and auto-fills the form
- Content check scores each file (readable text, wording for the document type, certificate number, dates, issuer) and fails files with nothing verifiable
- Stores a SHA-256 hash of each file to detect tampering, and flags duplicate certificate numbers across subjects
- Runs a **simulated** issuer-registry check (format and revoked list only)
- Classes documents as valid, expiring, needs review, expired, invalid or missing
- Scans every minute and raises or clears alerts
- Dashboard, filters, search, CSV export, audit log, light and dark mode
- Every dropdown has an "Other" option with free-text entry

## Not done yet

- Real issuer-registry integrations
- Authentication and per-company data isolation
- Email or SMS expiry reminders
- Multi-language OCR and image pre-processing

## Target stack

React, PostgreSQL on Supabase, deployed on Render, developed in VS Code.

## Credits

Made by VoidCilent02 with help from Claude (Anthropic).
