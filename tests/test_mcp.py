"""MCP server at /mcp (stateless streamable HTTP, JSON responses)."""


def rpc(client, method, params=None, id_=1):
    msg = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        msg["params"] = params
    return client.post("/mcp", json=msg).json()


def test_initialize_negotiates_version(client):
    res = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    assert res["result"]["protocolVersion"] == "2025-06-18"
    assert res["result"]["capabilities"] == {"tools": {"listChanged": False}}
    unknown = rpc(client, "initialize", {"protocolVersion": "1999-01-01"})
    assert unknown["result"]["protocolVersion"] == "2025-11-25"


def test_notifications_get_202(client):
    assert client.post("/mcp", json={"jsonrpc": "2.0", "method": "notifications/initialized"}).status_code == 202


def test_tools_list(client):
    names = [t["name"] for t in rpc(client, "tools/list")["result"]["tools"]]
    assert names == ["recolor_svg", "list_svg_colors", "list_recolor_modes"]


def test_recolor_tool(client, python_svg):
    res = rpc(client, "tools/call", {"name": "recolor_svg", "arguments": {"svg": python_svg, "mode": "solid", "color": "red"}})["result"]
    assert not res.get("isError")
    assert res["content"][0]["text"].startswith("<svg")
    assert {p["to"] for p in res["structuredContent"]["palette"]} == {"#ff0000"}


def test_tool_errors_are_reported_in_result(client, python_svg):
    res = rpc(client, "tools/call", {"name": "recolor_svg", "arguments": {"svg": python_svg, "color": "zzz"}})["result"]
    assert res["isError"] is True and "Invalid color" in res["content"][0]["text"]
    res = rpc(client, "tools/call", {"name": "list_svg_colors", "arguments": {}})["result"]
    assert res["isError"] is True


def test_protocol_errors(client):
    assert rpc(client, "tools/call", {"name": "nope", "arguments": {}})["error"]["code"] == -32602
    assert rpc(client, "nope")["error"]["code"] == -32601
    assert client.post("/mcp", content=b"{not json").status_code == 400
    assert client.get("/mcp").status_code == 405


def test_batch_requests(client):
    res = client.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}])
    assert res.json() == [{"jsonrpc": "2.0", "id": 1, "result": {}}]


def test_recolor_tool_takes_color_edits(client):
    svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#fff"/><path fill="#5e97f6" d="M0"/></svg>'
    res = rpc(client, "tools/call", {"name": "recolor_svg", "arguments": {
        "svg": svg, "mode": "solid", "color": "black", "remove": ["#ffffff"]}})["result"]
    assert "<rect" not in res["structuredContent"]["svg"]
    assert {p["from"]: p["to"] for p in res["structuredContent"]["palette"]}["#ffffff"] == "removed"
