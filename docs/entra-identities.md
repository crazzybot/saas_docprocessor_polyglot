# Microsoft Entra ID identities

Which identities the platform uses, and which of them you create by hand
before the first deployment. Most of them are user-assigned managed identities
that Terraform creates. You create only these:

| Identity | How many | Needed by |
|---|---|---|
| Admin security group | One per environment | AKS cluster-admin, PostgreSQL Entra admin |
| API app registration | One, or one per environment | document-service token validation |
| Test client app registration (optional) | One | Getting tokens to call the API |

Create them before step 2 of the first-time setup in
[`infra/README.md`](../infra/README.md).

## What you create by hand

### 1. Admin security group per environment

For example `docprocessor-dev-admins` and `docprocessor-prod-admins`.

- **What it's for:** members get cluster-admin on AKS through Entra RBAC
  ([`modules/aks/main.tf`](../infra/modules/aks/main.tf)). The group is also
  the Entra admin of the PostgreSQL server
  ([`modules/postgres/main.tf`](../infra/modules/postgres/main.tf)).
- **Members:** the people who operate the environment. Whoever runs
  [`create-postgres-role.sh`](../infra/scripts/create-postgres-role.sh) must be
  a member, because the script signs in to PostgreSQL with the group name as
  `PGUSER`.
- **Type:** a security group with no Entra roles. Use a separate group per
  environment so dev admins don't get prod access.
- **Where it goes:** put its object ID and display name in
  `infra/envs/<env>.tfvars`:

  ```hcl
  aks_admin_group_object_ids     = ["<group object ID>"]
  postgres_admin_group_object_id = "<group object ID>"
  postgres_admin_group_name      = "docprocessor-<env>-admins" # exact display name
  ```

### 2. API app registration (multi-tenant)

document-service validates customers' access tokens against this registration
([`auth.ts`](../services/document-service/src/api/auth.ts)). Each customer is
its own Entra tenant.

1. **Supported account types:** accounts in any organizational directory
   (multi-tenant).
2. **Expose an API:** set an Application ID URI, then add the permission that
   [`configmap.yaml`](../k8s/configmap.yaml) requires in
   `AZURE_AD_REQUIRED_SCOPE` (`Documents.Upload`):
   - as a **delegated scope**, for callers acting as a user, or
   - as an **app role**, for daemon callers.

   The service accepts either form: the scope in the `scp` claim or the app
   role in `roles`.
3. **Set the audience to match the tokens.** `AZURE_AD_AUDIENCE` in
   [`configmap.yaml`](../k8s/configmap.yaml) is a single value and must equal
   the tokens' `aud` claim:
   - With `accessTokenAcceptedVersion: 2` in the app manifest, `aud` is the
     app's **client ID** (a GUID).
   - With v1 tokens (the default), `aud` is the **Application ID URI**.

   Entra's default policy rejects a custom URI like `api://saas-docprocessor`
   on a multi-tenant app. Use `api://<client ID>` or an `https://` URI on a
   verified domain, and update the ConfigMap to match.
4. **No secret or certificate.** The service only validates tokens; it never
   requests them.

**Onboarding a customer:** an admin of the customer's tenant consents to the
app, which creates a service principal in their tenant. Add their tenant ID to
`AZURE_AD_ALLOWED_TENANT_IDS` and restart the document-service pods. Tokens
from any tenant not on that list are rejected.

**One registration or two:** one registration can serve every environment.
Separate dev and prod registrations keep test tokens from working against
prod, and are the safer choice.

### 3. Test client app registration (optional)

The web test client ([`apps/web-ui`](../apps/web-ui/README.md)) signs in
through this registration; it also works for getting tokens by hand.

1. **Supported account types:** accounts in any organizational directory
   (multi-tenant), so testers from any onboarded tenant can sign in.
2. **Platform:** Single-page application, with the redirect URI
   `https://app.docprocessor.example.com` (the app host, no trailing path).
   Add `http://localhost:5173` too if you run `just dev web-ui` in Entra mode.
3. **API permissions:** the API registration's `Documents.Upload` delegated
   scope. An admin of each tester's tenant consents to it, as for the API.
4. **No secret or certificate.** A SPA is a public client and uses PKCE.
5. **Where it goes:** its client ID, and the scope
   (`<API Application ID URI>/Documents.Upload`), go into `config.json` in
   [`k8s/web_ui.yaml`](../k8s/web_ui.yaml).

The tester's own tenant must be in `AZURE_AD_ALLOWED_TENANT_IDS`, or the API
answers 403 after a successful sign-in.

## What Terraform creates

These are all user-assigned managed identities, which are also service
principals in Entra. None of them has a secret: each signs in through a
federated credential. Don't create them by hand.

| Identity | Created in | Signs in as | Rights |
|---|---|---|---|
| `id-docprocessor-<env>-github` | [`bootstrap/main.tf`](../infra/bootstrap/main.tf) | GitHub OIDC, `repo:<owner/repo>:environment:<env>` | Contributor on the environment's two resource groups; RBAC Administrator there, limited to the roles the stack assigns; lock management; Blob Data Contributor on the state container |
| `id-<name>-workload` | [`modules/identities`](../infra/modules/identities/main.tf) | `system:serviceaccount:docprocessor:docprocessor-workload-identity` | Storage Blob Data Contributor; Service Bus Data Sender; Data Receiver on the `extraction-jobs` queue and the results subscription; its own PostgreSQL role |
| `id-<name>-keda` | [`modules/identities`](../infra/modules/identities/main.tf) | `system:serviceaccount:kube-system:keda-operator` | Service Bus Data Owner on the `extraction-jobs` queue only |
| AKS control plane and kubelet | [`modules/aks`](../infra/modules/aks/main.tf) | AKS itself | Network Contributor; AcrPull |

The workload identity's PostgreSQL role is the one step Terraform can't do;
`create-postgres-role.sh` creates it (step 6 of the first-time setup).

After `terraform apply`, `terraform -chdir=infra output k8s_values` prints the
client IDs that go into [`k8s/serviceaccount.yaml`](../k8s/serviceaccount.yaml)
and [`k8s/keda_scaledobject.yaml`](../k8s/keda_scaledobject.yaml). The
bootstrap's `terraform output ci_client_ids` prints the CI client IDs that go
into the GitHub environments' `AZURE_CLIENT_ID` variable.

## Permissions you need

- **Subscription Owner**, to run the bootstrap. It creates role assignments
  and a custom role definition.
- **Rights to create groups and app registrations in Entra.** By default any
  user can register apps. If your tenant restricts that, you need Application
  Developer or Cloud Application Administrator. Creating security groups may
  need Groups Administrator, depending on tenant settings.

## Order

1. Create the admin group for each environment and the API app registration.
2. Fill in `infra/envs/<env>.tfvars` with the group object IDs and names.
3. Run the bootstrap, then follow the rest of
   [`infra/README.md`](../infra/README.md).
4. Set `AZURE_AD_AUDIENCE`, `AZURE_AD_REQUIRED_SCOPE` and
   `AZURE_AD_ALLOWED_TENANT_IDS` in [`k8s/configmap.yaml`](../k8s/configmap.yaml).
