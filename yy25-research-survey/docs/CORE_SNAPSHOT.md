# Core snapshot boundary

Included: public-server HTTP/security/config/store modules, public frontend shell, and isolated security tests.

Excluded: questionnaire and scoring source bundle, administrator UI, deployment secrets/configuration, invitation codes, databases, responses, QR artifacts, and logs. The copied HTTP integration test still requires the separately controlled source bundle. `npm test` runs only the sanitized security-core suite.

