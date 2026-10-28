import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

it("applies all migrations and keeps import checkpoints server-only", async () => {
  const db = new PGlite();
  try {
    // Minimal Supabase auth foundation for the repository's migrations.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create schema auth;
      create table auth.users (id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      grant usage on schema public to anon, authenticated, service_role;
    `);
    const migrations = resolve(process.cwd(), "../../supabase/migrations");
    for (const filename of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
      await db.exec(readFileSync(resolve(migrations, filename), "utf8"));
    }
    const { rows: [org] } = await db.query<{ id: string }>("insert into organisations(name) values ('Import test') returning id");
    const { rows: [conn] } = await db.query<{ id: string }>("insert into google_connections(organisation_id,google_account_email) values ($1,'test@example.com') returning id", [org.id]);
    const { rows: [prop] } = await db.query<{ id: string }>("insert into gsc_properties(organisation_id,google_connection_id,property_uri,property_type) values ($1,$2,'sc-domain:example.com','domain') returning id", [org.id, conn.id]);

    await db.exec("set role service_role");
    await db.query("insert into gsc_import_days(gsc_property_id,date,rows_imported) values ($1,'2026-10-25',0)", [prop.id]);
    await db.query("update gsc_import_days set rows_imported=2 where gsc_property_id=$1", [prop.id]);
    expect((await db.query("select rows_imported from gsc_import_days")).rows).toEqual([{ rows_imported: 2 }]);
    await expect(db.query("insert into gsc_import_days(gsc_property_id,date,rows_imported) values ($1,'2026-10-24',-1)", [prop.id])).rejects.toThrow(/check constraint/);
    await expect(db.query("insert into gsc_import_days(gsc_property_id,date,rows_imported) values ($1,'2026-10-25',0)", [prop.id])).rejects.toThrow(/unique constraint/);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`);
      for (const query of [
        "select * from gsc_import_days",
        `insert into gsc_import_days(gsc_property_id,date,rows_imported) values ('${prop.id}','2026-10-24',0)`,
        "update gsc_import_days set rows_imported=0",
        "delete from gsc_import_days",
      ]) await expect(db.exec(query)).rejects.toThrow(/permission denied/);
    }
    await db.exec("reset role");
    expect((await db.query("select relrowsecurity from pg_class where oid='gsc_import_days'::regclass")).rows).toEqual([{ relrowsecurity: true }]);
    await db.query("delete from gsc_properties where id=$1", [prop.id]);
    expect((await db.query("select * from gsc_import_days")).rows).toEqual([]);
  } finally {
    await db.close();
  }
}, 20000);
