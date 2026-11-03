"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginIdOf = loginIdOf;
function loginIdOf(user) {
    return user.loginUserId ?? user.sub;
}
//# sourceMappingURL=jwt-payload.interface.js.map