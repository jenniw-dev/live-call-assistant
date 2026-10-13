# Account, Security and Data

## S01：Do you support single sign-on?

> Yes, on Business and Enterprise. We support SAML 2.0 with Okta, Microsoft Entra ID (formerly Azure AD), Google Workspace and OneLogin. An admin sets it up in Settings, Security, Single sign-on.

**Follow-up: Can we force everyone to use SSO?**
> Yes. Once SSO is tested, admins can turn on "Require SSO", and password logins are switched off for everyone except the workspace owner as a backup.

## S02：Do you support SCIM user provisioning?

> SCIM is included on Enterprise only. It works with Okta and Microsoft Entra ID to create and remove users automatically.

## S03：Do you have two-factor authentication?

> Yes, on every plan including Free. Users can turn it on with an authenticator app. On Business and Enterprise, admins can require it for the whole workspace.

## S04：Are you SOC 2 compliant?

> Yes. Pebblework has a SOC 2 Type II report, renewed every year. Customers on Business or Enterprise can request it through the trust portal after signing an NDA.

## S05：Are you GDPR compliant?

> Yes. We act as a data processor under GDPR and offer a standard Data Processing Agreement that customers can sign from Settings, Legal.

## S06：Where is our data stored?

> By default, data is stored on AWS in the United States, in us-east-1. Enterprise customers can choose EU hosting in Frankfurt.

**Follow-up: Can a Business customer move their data to the EU?**
> Not on Business. EU data residency is an Enterprise feature, so offer to connect them with sales.

## S07：Is our data encrypted?

> Yes. Data is encrypted at rest with AES-256 and in transit with TLS 1.2 or higher.

## S08：Can I export my data?

> Yes, on every plan including Free. Admins can export all projects, tasks and comments as CSV or JSON from Settings, Data, Export. Large workspaces get an email with a download link, usually within an hour.

## S09：What happens to deleted tasks or projects?

> Deleted items stay in the trash for 30 days and can be restored by anyone who had access. After 30 days they're permanently deleted.

## S10：What happens to our data if we cancel?

> After cancellation, the workspace becomes read-only for 90 days so you can export everything. After 90 days, the data is permanently deleted. If you need it deleted sooner, the workspace owner can request deletion from Settings, Data.

## S11：Can you install Pebblework on our own servers?

> No. Pebblework is cloud-only; there's no on-premise or self-hosted version.

## S12：How do I transfer workspace ownership?

> The current owner can transfer it in Settings, Members, by choosing a new owner who's already an admin. If the owner has left the company, an admin needs to contact support from a company email address, and we verify the request before transferring.
