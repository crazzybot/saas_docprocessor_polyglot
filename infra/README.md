# Azure infrastructure

Terraform for one AKS-based environment of the document processing platform,
plus a one-time bootstrap. It creates everything the manifests in
[`k8s/`](../k8s/) expect to exist.

```
bootstrap/        one-time, local state: state storage, resource groups, CI identities
main.tf           one environment, composed from the modules below
modules/
  network/        VNet, node + private endpoint subnets, NAT gateway, private DNS, gateway IP
  monitoring/     Log Analytics, Azure Monitor workspace (managed Prometheus), collection rules
  registry/       ACR (Entra ID only)
  messaging/      Service Bus namespace, queue, topics, subscriptions, filter
  storage/        Blob storage + containers, private endpoint
  postgres/       PostgreSQL 16 Flexible Server, Entra ID only, private endpoint
  aks/            AKS cluster, node pools, add-ons, Gateway API, monitoring hookup
  identities/     Workload identities (app, KEDA), federated credentials, RBAC
envs/             <env>.tfvars and <env>.backend.hcl per environment
tests/            plan tests against mocked providers (no Azure needed)
scripts/          create-postgres-role.sh (the one step Terraform can't do)
```

## What gets built

| | dev | prod |
|---|---|---|
| AKS | 1.36+, Standard tier, zones 1–3, system pool (3–5) + apps pool | same, larger apps pool, Defender |
| Ingress | App routing Gateway API (`approuting-istio`), static public IP | same |
| Service Bus | Standard, public endpoint (Standard has no private endpoint) | Premium, private endpoint |
| Storage | LRS, private endpoint | ZRS, private endpoint, delete lock |
| PostgreSQL | Burstable B1ms, private endpoint | General Purpose, zone-redundant HA, 35-day backups, delete lock |
| ACR | Standard | Premium (zone-redundant, untagged manifests purged) |

Choices that hold for every environment:

- **No secrets anywhere.** Shared keys are off on Storage, Service Bus and
  Log Analytics. PostgreSQL accepts Entra ID tokens only. Pods use Workload
  Identity, and CI signs in through GitHub OIDC.
- **Private data plane.** Storage, PostgreSQL and (Premium) Service Bus are
  reachable only through private endpoints. ACR keeps its public endpoint so
  GitHub-hosted runners can push, but it's Entra ID only.
- **Least privilege.** The app identity gets only the roles listed in
  `k8s/serviceaccount.yaml`. KEDA has its own identity, which holds Data Owner
  on the queue only. CI may assign only the roles the stack itself uses.
- **One environment per state file.** Each environment uses the same code
  with its own `envs/<env>.tfvars`.

## First-time setup

You need Terraform 1.14 (`mise install`), the Azure CLI, kubectl and kubelogin.

1. **Prerequisites in Entra ID:** an admin group per environment (for AKS
   cluster-admin and the PostgreSQL Entra admin), and the multi-tenant API app
   registration (see the main README).
2. **Bootstrap**, as a subscription Owner:
   ```bash
   cd infra/bootstrap
   cp terraform.tfvars.example terraform.tfvars   # subscription, GitHub repo
   az login
   terraform init && terraform apply
   ```
   Keep `terraform.tfstate` safe; it's gitignored. Optionally migrate it into
   the state account afterwards.
3. **GitHub:** create the environments `dev` and `prod`, add required
   reviewers on `prod`, and set these variables on each environment:
   `AZURE_CLIENT_ID` (from `terraform output ci_client_ids`),
   `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID`.
4. **Fill in `envs/<env>.tfvars`:** the subscription, the admin group object
   IDs and names, globally unique resource names if the defaults are taken,
   and `api_server_authorized_ip_ranges`.
5. **Plan and apply.** You need Storage Blob Data Contributor on the state
   container; bootstrap grants this to whoever runs it.
   ```bash
   just infra-plan dev
   just infra-apply dev
   ```
6. **Create the database role.** This needs network access, so it runs from
   inside the cluster:
   ```bash
   $(terraform -chdir=infra output -raw aks_get_credentials)
   $(terraform -chdir=infra output -raw postgres_role_command) <admin-group-name>
   ```
7. **Wire the manifests.** `terraform -chdir=infra output k8s_values` prints
   every value the files in `k8s/` need: the client IDs, `DATABASE_URL`, the
   gateway IP name, and so on. Point the API host's DNS A record at
   `gateway_public_ip`.

Then install cert-manager with Gateway API enabled
(`--set config.enableGatewayAPI=true`) and the OTel collector, and apply
`k8s/` in the order the main README gives.

## Day to day

- `just infra-check` runs fmt, validate and the plan tests. CI runs it on
  every change under `infra/`.
- `just infra-plan <env>` / `just infra-apply <env>`. Read the plan before
  applying. Anything that replaces storage, Service Bus or PostgreSQL is
  blocked in prod by the delete locks; remove a lock deliberately if the
  replacement is intended.
- `just infra-destroy <env>` tears the environment down to stop the charges.
  It keeps the bootstrap (state storage and the resource groups), so
  `infra-plan`/`infra-apply` bring it back; repeat the database role and
  manifest steps afterwards. Data in PostgreSQL, storage and Service Bus is
  lost. In prod, remove the `cannot-delete` locks first.
- AKS patch versions and node images upgrade themselves inside the Sunday
  maintenance windows. Minor upgrades are a deliberate change to
  `kubernetes_version`.

## Known gaps

- **The `k8s/` manifests still hold prod values.** Per-environment overlays
  that take them from `k8s_values` come with the deployment pipeline.
- **There's no plan/apply workflow yet.** The CI identities and GitHub
  environments are ready for one.
- **The Gateway API settings are applied through `azapi`.** azurerm 5.8 has
  no attribute for them. After any change to the cluster, check that
  `kubectl get gatewayclass approuting-istio` is still accepted.
- **No WAF and no rate limiting at the edge.** The Gateway API
  implementation offers neither; per-tenant rate limiting belongs in
  document-service.
- **Each bootstrap identity's Contributor scope covers its environment's two
  resource groups.** Tighten it further only if separate teams own network
  and workload.
