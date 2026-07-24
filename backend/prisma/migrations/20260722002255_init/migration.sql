-- CreateTable
CREATE TABLE "entitlement_registry" (
    "registry_id" BIGINT NOT NULL,
    "employee_id" VARCHAR(50) NOT NULL,
    "system_name" VARCHAR(50) NOT NULL,
    "entitlement_key" VARCHAR(100) NOT NULL,
    "granted_date" TIMESTAMP NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "entitlement_registry_pkey" PRIMARY KEY ("registry_id")
);

-- CreateIndex
CREATE INDEX "entitlement_registry_employee_id_idx" ON "entitlement_registry"("employee_id");
