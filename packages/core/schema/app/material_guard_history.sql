-- Installation metadata only. History may reject a home; it never attests the installed guard.
CREATE VIEW app.material_guard_history AS SELECT version, checksum FROM ops.schema_migrations;
REVOKE ALL ON app.material_guard_history FROM PUBLIC, backbone_app;
GRANT SELECT ON app.material_guard_history TO backbone_app;
