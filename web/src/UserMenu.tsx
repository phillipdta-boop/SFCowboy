import { supabase } from "./supabaseClient.js";

export function UserMenu({ name, email }: { name: string; email: string }) {
  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="user-menu">
      <span className="user-menu-name" title={email}>
        {name}
      </span>
      <button type="button" onClick={handleLogout}>
        Log out
      </button>
    </div>
  );
}
