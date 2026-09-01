# MCP Server

Status: contract placeholder for M1.

The Agent-facing surface is intentionally limited to seven high-level tools:

1. `create_design`
2. `modify_design`
3. `inspect_design`
4. `render_design`
5. `validate_design`
6. `export_design`
7. `prepare_print`

M0 does **not** expose backend-specific CadQuery/OpenCascade commands over MCP. The future server will call the CAD worker through typed project/revision contracts.
