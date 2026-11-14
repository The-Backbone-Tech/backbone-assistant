// Qualified only from a disposable exact predecessor; no user catalogue supplies pins.
export const IDENTITY_HARDENING_PINS: ReadonlyArray<{version:string;payload:string;predecessor:string;catalogue:string}> = [
  {
    "version": "identity-role-closure-v1",
    "payload": "51bdb53e46134eb9ea7fec6156be8b3b5d34fe35b9132edc66c8097241c2f5fd",
    "predecessor": "e8c301d78ff2ffc2c9282d03a7ef53af6685053e8679860376e13a96302af6e5",
    "catalogue": "34c591682a72547a0f296a8c29fffb3c63cf99317a5ab0de77da6bdf948254b9"
  },
  {
    "version": "identity-piece-admission-v1",
    "payload": "f9f2531ed0f1fe26f1305922b4bb6873515d3c09fd9a3092a8934c35ac1d0630",
    "predecessor": "34c591682a72547a0f296a8c29fffb3c63cf99317a5ab0de77da6bdf948254b9",
    "catalogue": "25c5a46b025b6b0de6c1a80874ce0de6bf7fcc41d757d82364ad470b2488aabf"
  },
  {
    "version": "identity-lookup-closure-v1",
    "payload": "39e3d61b7f95ae3cb4d4ec638846b3a6d3062b58850a77a085f6d7e1c3a9612e",
    "predecessor": "25c5a46b025b6b0de6c1a80874ce0de6bf7fcc41d757d82364ad470b2488aabf",
    "catalogue": "d7e643e0452a75290d53e819becabcc9d713faadbefb016c67384fede0e8ca0c"
  },
  {
    "version": "identity-invitation-closure-v1",
    "payload": "ad645206d7b21ce7cdc9c9c6eae1912a5c491e5b711172546fc2a6245b94b637",
    "predecessor": "d7e643e0452a75290d53e819becabcc9d713faadbefb016c67384fede0e8ca0c",
    "catalogue": "dd1f1d209e81af0c25beaffa133a75d394891f1d3c9dfbb14e5c862f962985a0"
  },
  {
    "version": "identity-device-recovery-v1",
    "payload": "51ac3dd57a023a7d3af0e0fb412d6c4933c4ba857df62eeffa64e5f731900f72",
    "predecessor": "dd1f1d209e81af0c25beaffa133a75d394891f1d3c9dfbb14e5c862f962985a0",
    "catalogue": "34100db5e60654c4c4422d88f65baa8ddc44812e861d5e08495e8640965ecb5e"
  },
  {
    "version": "identity-device-lockout-v1",
    "payload": "6a2214638918e8ae7b80a6c2805359d8a785320bdd8fade086ec16faed8c49e3",
    "predecessor": "34100db5e60654c4c4422d88f65baa8ddc44812e861d5e08495e8640965ecb5e",
    "catalogue": "8282a256b18eca96f5292bd62afe4671e1f0f4bca0a99825af7ace0f40ad0772"
  },
  {
    "version": "identity-device-subject-v1",
    "payload": "96bdcbac3eeb00107c02fdca46fa347c06599d7340dc0b709090fb25a558b89f",
    "predecessor": "8282a256b18eca96f5292bd62afe4671e1f0f4bca0a99825af7ace0f40ad0772",
    "catalogue": "d4d7030e91c60f3b612c6f4a037d53a854176446feed6a016f681fb237432691"
  },
  {
    "version": "identity-native-turn-v1",
    "payload": "fab111a5f958290f3617600bbe8801125fa190eb8b007a5457b0e562f949aedd",
    "predecessor": "d4d7030e91c60f3b612c6f4a037d53a854176446feed6a016f681fb237432691",
    "catalogue": "eac106a4a337d6905cbd7ee8cdb6506c4959d10dade24a3b21d50d3429a1f8ed"
  },
  {
    "version": "identity-device-current-v1",
    "payload": "fe38f389b4217616f81cc7ac47c1f4aab82643a8d419344b6b4639c72b1cf88a",
    "predecessor": "eac106a4a337d6905cbd7ee8cdb6506c4959d10dade24a3b21d50d3429a1f8ed",
    "catalogue": "d1fe110dc4e1ebba21ca58a28b92317a63cde54b6635044bf51a25fbfe09a6a6"
  }
];
