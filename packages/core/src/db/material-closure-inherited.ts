// Frozen inherited material profile, preserving all released claim encodings.
// Source hashes rechecked unchanged at qualified 78c12d0bb951bba5870c7612d0938a1a1980d1ef.
export const INHERITED = {
  "inputCommit": "70782c480253c433ff9fa7105310b97a9c94f636",
  "sourceHashes": {
    "material-guard.ts": "fcff939d0befccb0bd882b888fc9a8aee6441cf2d4e9d600cc7768d201717d8d",
    "material-link.ts": "684471a42ee1fa90527fa3493e3830c1442d4f0d6a591a67c250385c6b633287",
    "material-enforcement.ts": "dcbdc4398c12ce11f65ddfced7e0d3c8d66c32dbdbff93a068cec452ee2c0ef1",
    "material-enforcement-catalogue.ts": "90cb42d394c54b1b419f1235a4962ed99c57d3afcf4f4be7b4f46b6d3c563915"
  },
  "signatures": [
    "gov._ancestors(uuid)",
    "gov._append(text,text,jsonb,uuid)",
    "gov._claim(uuid,text,integer)",
    "gov._claimable(uuid,boolean)",
    "gov._holder(uuid,bigint)",
    "gov._lock_workspace()",
    "gov._mandate_standing(uuid)",
    "gov._mark(uuid,text,text,text)",
    "gov._material_source_state(uuid)",
    "gov._person_name(uuid)",
    "gov._promote(uuid,uuid,uuid)",
    "gov._promotion_sources_allowed(uuid)",
    "gov._run_person(uuid)",
    "gov._settle_decision(uuid,text,uuid,text)",
    "gov._stop_run(uuid,text,text)",
    "gov._subtree(uuid)",
    "gov._system(text)",
    "gov._wake_run(uuid)",
    "gov.answer_decision(uuid,text,text,text)",
    "gov.claim_next_verification(text,integer)",
    "gov.claim_run(uuid,text,integer,text,uuid)",
    "gov.finish_run(uuid,bigint,text)",
    "gov.may_decide(uuid)",
    "gov.park_run(uuid,bigint)",
    "gov.propose_candidate(text,jsonb,uuid,text)",
    "gov.recall_knowledge(uuid,text[],integer)",
    "gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)",
    "gov.record_server_answer(uuid,uuid,text,text)",
    "gov.record_source(text,text,text,uuid,uuid,uuid,text,uuid)",
    "gov.renew_run_lease(uuid,bigint,integer)",
    "gov.request_promotion(uuid,uuid,timestamp with time zone,timestamp with time zone)",
    "gov.run_standing(uuid)",
    "gov.verifier_answer(uuid,text,text)",
    "gov.withdraw_material_source(text,text,text,integer,integer,text)",
    "sec.acting_for()",
    "sec.candidate_visible(uuid)",
    "sec.current_principal()",
    "sec.current_run()",
    "sec.current_workspace()",
    "sec.decision_visible(uuid)",
    "sec.digest(text)",
    "sec.ledger_hash(text,uuid,bigint,text,uuid,text,jsonb,timestamp with time zone)",
    "sec.names_run()",
    "sec.piece_binding(uuid)",
    "sec.system_principal()",
    "sec.t_candidate()",
    "sec.t_evidence()",
    "sec.t_knowledge()",
    "sec.t_ledger_append_only()",
    "sec.t_material_episode_source()",
    "sec.t_material_promotion_guard()",
    "sec.t_principal()",
    "sec.t_refuse_truncate()",
    "sec.t_run_marks()",
    "sec.t_run_piece()",
    "sec.task_visible(uuid)",
    "sec.task_visible_to(uuid,uuid)",
    "sec.viewer()",
    "sec.visible_eligible_knowledge_sources()"
  ],
  "definitionClaims": [
    {
      "family": "guard",
      "signature": "gov._append(text,text,jsonb,uuid)",
      "hash": "bd2229fa2ad637710dca59f091fe8398f3dda10312507400d460b9562a6467ce"
    },
    {
      "family": "link",
      "signature": "gov._lock_workspace()",
      "hash": "8d6f4837bfc5139a7098072c671c364411f9b2a04a8dd32d70838de2680c9915"
    },
    {
      "family": "link",
      "signature": "gov._mark(uuid,text,text,text)",
      "hash": "b2aa0fc5f3f2e8aff42874e6406b333bf7b6d59c1521dad9d5a7ee4086061da8"
    },
    {
      "family": "link",
      "signature": "gov._person_name(uuid)",
      "hash": "0a6c045ec567b01f44500544a9b1adcad3103f7c3bb1a0ea7b4799fb472bb794"
    },
    {
      "family": "guard",
      "signature": "gov._promote(uuid,uuid,uuid)",
      "hash": "14eb32c4e67b4c40adc49723b738e88972f8d91d8aab76f72bc3e65cecd2561e"
    },
    {
      "family": "guard",
      "signature": "gov._promotion_sources_allowed(uuid)",
      "hash": "ad9a9464fe56f25ab1cb056afe89ac1ea6088ae2586e0f28b552d43e2bc9e6b2"
    },
    {
      "family": "link",
      "signature": "gov._run_person(uuid)",
      "hash": "8264cc2656a64135907fe2bdc97ef2d0391e58fd034a5afc6656a399c62e0d7c"
    },
    {
      "family": "guard",
      "signature": "gov._settle_decision(uuid,text,uuid,text)",
      "hash": "5e5f7eb5de6ec684132de4e8cbed129b9ab3177b5aa14e501d5cd8a51eef666d"
    },
    {
      "family": "link",
      "signature": "gov._system(text)",
      "hash": "506717ded9ec36d400f421e43e9bb9fd965dfa5f856a6ad9b2f0270f3d2ddf7a"
    },
    {
      "family": "guard",
      "signature": "gov.answer_decision(uuid,text,text,text)",
      "hash": "0243f9d9d54550660c43a8382f6fdd90ea579f878ca106c902fac77671d8b01c"
    },
    {
      "family": "guard",
      "signature": "gov.claim_next_verification(text,integer)",
      "hash": "a32f9d5bdc272b5766b27e9131c70f1f5c5f891f602f3c52da29e45bd1802cd9"
    },
    {
      "family": "guard",
      "signature": "gov.may_decide(uuid)",
      "hash": "69e1e760f76e865300050a8b1286a08933dddea7d8dac01835279d18dd8bb466"
    },
    {
      "family": "guard",
      "signature": "gov.propose_candidate(text,jsonb,uuid,text)",
      "hash": "86ac147b0cf383f464589a8922650fe8ad29cc310f4d0e712e83e15dc3d9ebff"
    },
    {
      "family": "guard",
      "signature": "gov.recall_knowledge(uuid,text[],integer)",
      "hash": "ed7185c90928287beb6a20654521ef54280c2278a7be38232162b8161122dd70"
    },
    {
      "family": "link",
      "signature": "gov.record_material_source_read(text,text,integer,integer,text,text,jsonb,text,text,text,uuid,uuid,uuid,uuid,text)",
      "hash": "fc7d68b81fe56df5e453f08a19025c457714381e0955b6427dda5eabbc82f70f"
    },
    {
      "family": "guard",
      "signature": "gov.record_server_answer(uuid,uuid,text,text)",
      "hash": "0834bfb712bfae9fa4d62b12867be09779572fe54772dd62e5c8f236eca30c87"
    },
    {
      "family": "guard",
      "signature": "gov.record_source(text,text,text,uuid,uuid,uuid,text,uuid)",
      "hash": "a1304c87814b01bb2dd19509f4eb89d2ca4b74709566592cb67231fcfef969dd"
    },
    {
      "family": "guard",
      "signature": "gov.request_promotion(uuid,uuid,timestamp with time zone,timestamp with time zone)",
      "hash": "5e1f686a3eeec77c4101fdacdda7e627e898eb79a9e16e762a0f6197d0fa7fad"
    },
    {
      "family": "guard",
      "signature": "gov.verifier_answer(uuid,text,text)",
      "hash": "d7655f3e93c8b484a940b71f90089aa1bf9d32a04ee1d430326a2a189b8dac8d"
    },
    {
      "family": "link",
      "signature": "gov.withdraw_material_source(text,text,text,integer,integer,text)",
      "hash": "f15350fab565b61a3d1ed2f634e73f1e87775371f5a5489375c4100201647eff"
    },
    {
      "family": "guard",
      "signature": "sec.candidate_visible(uuid)",
      "hash": "eea327c52f3dcc8b85a52bedea8e6f9aa198d87a2625e97ac99aa3910d838d5b"
    },
    {
      "family": "link",
      "signature": "sec.current_principal()",
      "hash": "f45a2dc923a72033984f7a58b5fb5f86e31dcde077e6c2e1c8968fef5d9aecd0"
    },
    {
      "family": "link",
      "signature": "sec.current_run()",
      "hash": "c0af0f0990e25fbad69e789495524ffc0442010d47b9389e22c8ae44c609b4c0"
    },
    {
      "family": "link",
      "signature": "sec.current_workspace()",
      "hash": "f45d4a6c70fdd5007f8b2ee0764ffdda935b9c1b9b072c72b2aae1392b087da3"
    },
    {
      "family": "guard",
      "signature": "sec.decision_visible(uuid)",
      "hash": "7d7c9b7d99de7a89d25e63d32bbf5e9a50727c476acee09bc5d220521fe11fd3"
    },
    {
      "family": "link",
      "signature": "sec.digest(text)",
      "hash": "8a22e9c88f36efbbe90d7919b05eeec2b06cbd41636fe9e2f61662d7a243e29b"
    },
    {
      "family": "link",
      "signature": "sec.ledger_hash(text,uuid,bigint,text,uuid,text,jsonb,timestamp with time zone)",
      "hash": "dc46a13fec1e28dd4a5766c166d929981441cb36a7c40cb5301d7f422382caab"
    },
    {
      "family": "link",
      "signature": "sec.names_run()",
      "hash": "7d48058670c251fa7a25cbe8cdad58cc653d00f07f728758424c91de42fd8580"
    },
    {
      "family": "link",
      "signature": "sec.system_principal()",
      "hash": "e0bbe97191ecd993b4f41f88ace3610922ab002e92f0f9fa34d8687f5af53e41"
    },
    {
      "family": "guard",
      "signature": "sec.t_candidate()",
      "hash": "370a8f11c3e0848d5c3ea07b3c503d4f36079467295d303ea95379ebacde3c6d"
    },
    {
      "family": "guard",
      "signature": "sec.t_evidence()",
      "hash": "d4d7b1ddf6b1cce924cf9129d0869234aa55e9d52c3648c0ba58c5183af9f2f0"
    },
    {
      "family": "link",
      "signature": "sec.t_evidence()",
      "hash": "d4d7b1ddf6b1cce924cf9129d0869234aa55e9d52c3648c0ba58c5183af9f2f0"
    },
    {
      "family": "guard",
      "signature": "sec.t_knowledge()",
      "hash": "85a2184842ebc2ca0c7c812cfd4d80e6083459e9e8bc2e44aa7afa824ec3c8aa"
    },
    {
      "family": "guard",
      "signature": "sec.t_ledger_append_only()",
      "hash": "07c8d8fb70f34d5f9925d245ef2ba351ea8c3ae1a1aab852948fe5ff48b5ffe2"
    },
    {
      "family": "guard",
      "signature": "sec.t_material_promotion_guard()",
      "hash": "d3b77857de19ca99250970f4b52dcd1ecd29f7bd3c882ee30cf170cef2dcc0e5"
    },
    {
      "family": "guard",
      "signature": "sec.t_principal()",
      "hash": "81ae4944dc1a2321195e664b24f1d1ec804b037ae0f39e098c11b47c35904414"
    },
    {
      "family": "guard",
      "signature": "sec.t_refuse_truncate()",
      "hash": "d2f47eb245401e46569ff535020053c287123860505c09295f863c879fb07048"
    },
    {
      "family": "link",
      "signature": "sec.t_refuse_truncate()",
      "hash": "d2f47eb245401e46569ff535020053c287123860505c09295f863c879fb07048"
    },
    {
      "family": "link",
      "signature": "sec.task_visible_to(uuid,uuid)",
      "hash": "1ab60c3845c73b0b16d1910681a665a03a111894a939bf659b0f5f8f0062ee48"
    },
    {
      "family": "guard",
      "signature": "sec.visible_eligible_knowledge_sources()",
      "hash": "fb2a5c4aec7bf23f4be9226c9f3482485d8333e9d5ff52dff57f2173745f7175"
    }
  ],
  "nativeSpecs": {
    "gov._ancestors(uuid)": {
      "body": "f4c56081bc3d17b027dd96a79e6ef7c8f0d8c5709084657b300efbe568d2f5a8",
      "language": "sql",
      "volatility": "s",
      "result": "uuid",
      "set": true,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_mandate"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._claim(uuid,text,integer)": {
      "body": "49bb5b86466831b8a82965a7ecd3d211a9c300fb1912bdd98cba92f7698cfbde",
      "language": "plpgsql",
      "volatility": "v",
      "result": "record",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_worker",
        "p_lease_ms",
        "fence",
        "secret"
      ],
      "argumentModes": [
        "i",
        "i",
        "i",
        "o",
        "o"
      ],
      "allArgumentTypes": [
        "uuid",
        "text",
        "integer",
        "bigint",
        "text"
      ],
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._claimable(uuid,boolean)": {
      "body": "2642ab8b5ed28259075f9323a4274c2541c5b16a109e75db3dce778a25d0059f",
      "language": "sql",
      "volatility": "s",
      "result": "boolean",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_from_queue"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._holder(uuid,bigint)": {
      "body": "7ef2152e33970c4e763dac7dc58ec3e14122661f9e2e3773879852704693692a",
      "language": "plpgsql",
      "volatility": "v",
      "result": "app.runs",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_fence"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._mandate_standing(uuid)": {
      "body": "10c1ce47013ec478e401cb6a6290f1b18670c1ed275f1a3aae92ae59fee2ee49",
      "language": "plpgsql",
      "volatility": "s",
      "result": "text",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_mandate"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._material_source_state(uuid)": {
      "body": "b1bbb48853615c2b126e7e0826d79989aeb6567515b9b482bbcfb92598ed2245",
      "language": "plpgsql",
      "volatility": "v",
      "result": "text",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_episode"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._stop_run(uuid,text,text)": {
      "body": "1b0f5d47ff3b7845342b56da159e5b86306818bf52061ab0240215c0f1f91891",
      "language": "plpgsql",
      "volatility": "v",
      "result": "void",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_status",
        "p_reason"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._subtree(uuid)": {
      "body": "c4f7b6c24b6b6ed72a186fe480124316340059f3b86a13802807627c5a5539aa",
      "language": "sql",
      "volatility": "s",
      "result": "uuid",
      "set": true,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_mandate"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov._wake_run(uuid)": {
      "body": "cba54bcc8b39002fc033d37a59f088ae7ef4484ad99f480729cb651e22cd0784",
      "language": "plpgsql",
      "volatility": "v",
      "result": "void",
      "set": false,
      "app": false,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov.claim_run(uuid,text,integer,text,uuid)": {
      "body": "d4f6dbf5ad5fd657995ac0b30a1dc7805e18fd5fa60dc54ad00a9e218bf3782f",
      "language": "plpgsql",
      "volatility": "v",
      "result": "record",
      "set": true,
      "app": true,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_worker",
        "p_lease_ms",
        "p_carrier",
        "p_piece",
        "fence",
        "secret"
      ],
      "argumentModes": [
        "i",
        "i",
        "i",
        "i",
        "i",
        "t",
        "t"
      ],
      "allArgumentTypes": [
        "uuid",
        "text",
        "integer",
        "text",
        "uuid",
        "bigint",
        "text"
      ],
      "defaults": 1,
      "defaultExpression": "NULL::uuid"
    },
    "gov.finish_run(uuid,bigint,text)": {
      "body": "1922359a81a6aeac56a63f4497977ebbd8df3f96bc9ba91c87df2cfadc3f3a84",
      "language": "plpgsql",
      "volatility": "v",
      "result": "text",
      "set": false,
      "app": true,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_fence",
        "p_outcome"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov.park_run(uuid,bigint)": {
      "body": "f6d2e233043c690544717c64bd239c74d0b7b30f48e2cb7b9ea9d806043a1515",
      "language": "plpgsql",
      "volatility": "v",
      "result": "text",
      "set": false,
      "app": true,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_fence"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov.renew_run_lease(uuid,bigint,integer)": {
      "body": "d0f4efa65694cac6acfe0654b2ddb0a07dc4e929e41f0bc7276ef2d7014bf9e7",
      "language": "plpgsql",
      "volatility": "v",
      "result": "timestamp with time zone",
      "set": false,
      "app": true,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run",
        "p_fence",
        "p_lease_ms"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "gov.run_standing(uuid)": {
      "body": "937c93a1d4ea8f71ce3d8101fabb0ff202c0a732c61eacae42e4094af5de87bd",
      "language": "plpgsql",
      "volatility": "v",
      "result": "text",
      "set": false,
      "app": true,
      "ownerExecute": false,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_run"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.acting_for()": {
      "body": "f31cad116fdd2e5d82e8054b5552cfed06efd8b32153be5b89619ced78f3bff2",
      "language": "sql",
      "volatility": "s",
      "result": "uuid",
      "set": false,
      "app": true,
      "ownerExecute": true,
      "definer": true,
      "parallel": "u",
      "argumentNames": null,
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.piece_binding(uuid)": {
      "body": "4a91484d9e88994a0e32d549c68968f35ee628db53305120ca472f0c6754cb22",
      "language": "sql",
      "volatility": "s",
      "result": "text",
      "set": false,
      "app": false,
      "ownerExecute": true,
      "definer": false,
      "parallel": "u",
      "argumentNames": [
        "p_piece"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.t_material_episode_source()": {
      "body": "5aea80446ed45333b7937e6ae9a6bc3cd0491e455c7de6052199018a866def7c",
      "language": "plpgsql",
      "volatility": "v",
      "result": "trigger",
      "set": false,
      "app": false,
      "ownerExecute": true,
      "definer": true,
      "parallel": "u",
      "argumentNames": null,
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.t_run_marks()": {
      "body": "d58abc189feff54fe185ec33d505b07820fb34c4d6719c6169cdcac52290660d",
      "language": "plpgsql",
      "volatility": "v",
      "result": "trigger",
      "set": false,
      "app": false,
      "ownerExecute": true,
      "definer": false,
      "parallel": "u",
      "argumentNames": null,
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.t_run_piece()": {
      "body": "f8f8c1485df755f4f1b7adb6383b6560130b0c606e848eacf63a014512a57c1f",
      "language": "plpgsql",
      "volatility": "v",
      "result": "trigger",
      "set": false,
      "app": false,
      "ownerExecute": true,
      "definer": false,
      "parallel": "u",
      "argumentNames": null,
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.task_visible(uuid)": {
      "body": "ac91e1420bb9c906ed8aebdb68a07466dfbb27f0f7b80b92f374f76c7d59d1b4",
      "language": "sql",
      "volatility": "s",
      "result": "boolean",
      "set": false,
      "app": true,
      "ownerExecute": true,
      "definer": true,
      "parallel": "u",
      "argumentNames": [
        "p_task"
      ],
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    },
    "sec.viewer()": {
      "body": "ec7fec6028bcba67a0147b09759be0f6ac70aeacc96997cd4787c5056e9044ed",
      "language": "sql",
      "volatility": "s",
      "result": "uuid",
      "set": false,
      "app": true,
      "ownerExecute": true,
      "definer": false,
      "parallel": "u",
      "argumentNames": null,
      "argumentModes": null,
      "allArgumentTypes": null,
      "defaults": 0,
      "defaultExpression": null
    }
  },
  "guardObjects": "2f807badd1fd73ee0ae9ec24ecb3e47ef416531c4b83c443155165d4638f17f0",
  "linkObjects": "1b36491fed742fb87faf1d33afb6932b4f20276f82e0ddee5fea39152792ca29",
  "linkRoles": "a6729e040029f302de55cc0a6683493fa3c7cb51fe270a730c54ee23788805ff"
} as const;
