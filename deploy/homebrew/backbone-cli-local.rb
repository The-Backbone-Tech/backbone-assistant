# Local formula; not published to a tap. Build the tarball with scripts/pack-cli.mjs.
# Set BACKBONE_CLI_TARBALL to that file. Rebuilds require updating the pinned digest.
class BackboneCliLocal < Formula
  desc "Backbone command line"
  homepage "https://github.com/The-Backbone-Tech/backbone"
  archive = ENV.fetch("BACKBONE_CLI_TARBALL", "/tmp/backbone-cli-local-0.2.0.tgz")
  url "file://#{archive}"
  version "0.2.0"
  sha256 "5b43a455549ff5251a2b9ee3647f0114820d7e78dd5ae326526b3d06f38c2932"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/backbone"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/backbone --version")
    ENV["BACKBONE_HOME"] = (testpath/"home").to_s
    ENV["BACKBONE_KEYS"] = "plaintext"
    ENV["BACKBONE_HARNESS"] = "stub"
    system bin/"backbone", "projects", "create", "Formula test"
    system bin/"backbone", "exec", "Check readiness", "--json"
    system bin/"backbone", "doctor", "--json"
  end
end
