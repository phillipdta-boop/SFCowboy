import { logout, type CurrentUser } from "./api/client.js";

/** Replaces the old free-text "Your name" field now that real accounts exist — shows who's
 * actually logged in and lets them log out. See displayName.ts's removal in this same task. */
export function UserMenu({ user }: { user: CurrentUser }) {
  async function handleLogout() {
    await logout();
    window.location.href = "/login";
  }

  return (
    <div className="user-menu">
      <span className="user-menu-name" title={user.email}>
        {user.name}
      </span>
      <button type="button" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}
