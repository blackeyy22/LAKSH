# RewardTree — Final SQLite Build

A polished Node.js membership + referral + reward platform prototype using SQLite. The customer side keeps the original v2 visual design, removes emoji UI, gates referral code/link creation until membership activation, supports adding a referral code after login, fixes dummy payment with CSRF, adds reward artwork, and lets admins remove featured store items.

## Included

- Premium customer landing page and member dashboard
- Mobile-friendly customer experience
- Optional referral code during signup
- Email OTP verification
- Password login + email OTP login
- Forgot-password email OTP flow
- Persistent database-backed sessions
- CSRF token protection for authenticated state-changing requests
- Rate limiting for signup, login, OTP and recovery endpoints
- Validation and secure error handling
- Dummy ₹250 membership payment flow
- Referral verification only after eligible membership payment
- 5-verified-referral reward milestone
- Referral link and share tools
- Member network count without exposing descendant identities
- Node.js admin console
- Interactive dark node hierarchy with zoom, pan and drag
- Search/filter/paginated member directory
- Dashboard analytics
- Reward settings and reward status tracking
- Store showcase management
- Audit log view
- Customer onboarding tour
- Customer activity timeline and notifications
- Company email service through SMTP environment variables
- OTP and account/payment/referral/reward email templates
- SQLite database stored in `data/rewardtree.db`

## Requirements

Node.js 22.5+ because the project uses the built-in `node:sqlite` API.

## Run

```bash
npm install
npm start
```

Open:

- Customer: http://localhost:3000/
- Admin: http://localhost:3000/admin-ui

## Environment

Copy `.env.example` to `.env`.

Important email variables:

```env
COMPANY_EMAIL=notifications@yourdomain.com
COMPANY_EMAIL_PASSWORD=your-email-password
COMPANY_EMAIL_NAME=RewardTree
SMTP_HOST=smtp.yourprovider.com
SMTP_PORT=587
SMTP_SECURE=false
```

The company mailbox is used to send:

- signup/email verification OTP
- login success notification
- login OTP
- password reset OTP
- successful membership/payment notification
- verified referral notification
- reward unlocked notification
- reward status updates

If SMTP is not configured, OTPs are printed to the Node.js terminal so the application remains usable in local development.

## Admin seed

Set these in `.env` before first startup:

```env
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=change-this-password
```

The first startup creates the admin account if it does not already exist.

## Database

SQLite file:

`data/rewardtree.db`

The schema is created automatically on startup. The `.gitignore` excludes SQLite database files from source control.

## Production notes

For an AWS deployment, the application can initially run on EC2 with the SQLite database on attached storage plus scheduled S3 backups. For larger production scale or multiple application instances, migrate the Prisma-equivalent relational model to PostgreSQL on Amazon RDS and move session/rate-limit state to Redis.

Do not expose a production database directly to the public internet. Keep SMTP secrets outside Git and use AWS Secrets Manager or Parameter Store when deploying to AWS.

Live payments and official WhatsApp Business API are intentionally not connected in this version.

## Auto Pool matrix

The app now keeps the personal referral relationship separate from the global Auto Pool position.

A member qualifies for the Auto Pool after 5 verified direct referrals. The first qualified member gets the global position 1. Every later qualified member fills the next position in a fixed-width matrix where each position can have up to 5 children and the depth can continue indefinitely.

The member view only shows:

- the member's own Auto Pool position
- the structure below that position
- placeholder position labels instead of descendant names

It does not show the member's Auto Pool parent, ancestor, sibling branch, names, phone numbers or email addresses.

The admin console shows the shared matrix with real member names and IDs, supports clicking occupied nodes, and can focus the graph on an individual qualified member.

The app visualizes the first 3 matrix levels as the tracked/rewarded stages:

- Stage 1: 5 positions
- Stage 2: 25 positions
- Stage 3: 125 positions

This version adds the matrix placement and visualization. It does not add new cash-payout rules to the existing physical-reward flow.


## Manual payment review
Members pay outside the app using the configured payment QR, then upload proof and submit it for admin review. Set `PAYMENT_UPI_ID` and `WHATSAPP_NUMBER` in `.env`. The admin approves/rejects from the Payments section.

## Offline member entry
Admins can create active members without online payment or email OTP from the Payments/Offline Entry section.

## WhatsApp Web
The admin quick-message tool opens WhatsApp Web with a prefilled message. Browser security prevents a website from silently attaching/sending a local image, so the image is uploaded to the site for easy opening and manual attachment in WhatsApp Web.
