-- JAK-146: text-customer profile fields. Add optional first_name, last_name and
-- email to the tier-1 text-Jake customer record. Phone stays the mandatory,
-- unique billing identifier (JAK-115); these three are all nullable so an
-- existing customer keeps working and a new one can be saved with a blank email.
alter table text_jake_customers
    add column if not exists first_name text,
    add column if not exists last_name  text,
    add column if not exists email      text;
