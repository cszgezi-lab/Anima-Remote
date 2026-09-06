#!/usr/bin/env node

const process = require("node:process");
const path = require("node:path");
const { TokenStore } = require("../server/auth");

process.umask(0o077);

const dataRoot = process.env.ANIMA_DATA_ROOT || "/var/lib/anima";
const tokenFile = process.env.ANIMA_TOKEN_FILE || path.join(dataRoot, "tokens.json");
const store = new TokenStore(tokenFile);
const args = process.argv.slice(2);
const command = args.shift() || "help";

function valueFor(flag) {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    return args[index + 1];
}

function printHelp() {
    console.log(`Usage:
  token-cli.js create --label <owner-or-friend-label>
  token-cli.js list
  token-cli.js revoke --id <token-id>
  token-cli.js revoke --label <label>

The raw token is printed only by create and is not stored in the token file.`);
}

async function main() {
    if (command === "help" || command === "--help") {
        printHelp();
        return;
    }

    if (command === "create") {
        const label = valueFor("--label") || args.find((item) => !item.startsWith("-"));
        if (!label) throw new Error("create requires --label");
        const created = await store.create(label);
        console.log(JSON.stringify(created, null, 2));
        return;
    }

    if (command === "list") {
        console.log(JSON.stringify(store.list(), null, 2));
        return;
    }

    if (command === "revoke") {
        const id = valueFor("--id");
        const label = valueFor("--label");
        if (!id && !label) throw new Error("revoke requires --id or --label");
        const revoked = await store.revoke({ id, label });
        if (!revoked) {
            process.exitCode = 2;
            console.error("No matching active or revoked token record was found.");
            return;
        }
        console.log(JSON.stringify(revoked, null, 2));
        return;
    }

    throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
    console.error(`[anima-token-cli] ${error.message}`);
    process.exitCode = 1;
});
