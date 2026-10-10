const identity = require("./helpers/appIdentity");

class AppReleaseInfo {
  async getAppVersion() {
    return { version: identity.version };
  }
}
module.exports = AppReleaseInfo;
