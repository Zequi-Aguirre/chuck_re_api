#!/bin/bash

npx supabase start
captured_key=$(npx supabase status | grep -oE 'service_role key: .*' | awk '{print $3}')
echo "ZOE_SUPABASE_ENV_OVERRIDE=$captured_key" > .supa
echo "ADMIN_EMAIL_OVERRIDE='Add your email here'" >> .supa
