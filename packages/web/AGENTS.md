# AGENTS.md — Web packages

Credential-bearing provider requests reject redirects before following them. Regression coverage proves the target is never contacted and every credentialed provider enables the policy. This prevents automatic credential or request-data forwarding; it does not protect a compromised configured endpoint.
