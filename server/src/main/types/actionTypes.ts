export type FunctionMethod = 'GET' | 'POST';

export type ActionServiceType = 'zapier' | 'internal';

export interface BaseFunction {
    id: string;
    name: string;
    description?: string;
    allowed_method: FunctionMethod;
    service_type: ActionServiceType;
    default_payload: Record<string, any>;
    stage?: string;
}

export interface InternalFunction extends BaseFunction {
    service_type: 'internal';
    internal_handler: string; // name of the internal method
}

export interface ZapierHookFunction extends BaseFunction {
    service_type: 'zapier';
    zapier_hook_id: string; // foreign key to zapier_hooks table
}

export type AssistantFunction = InternalFunction | ZapierHookFunction;

export interface AssistantContext {
    assistant_id: string;
    instructions: string;
    functions: AssistantFunction[];
}

export type AssistantFunctionLink = {
    id: string; // UUID of the row (optional, if you're storing one)
    assistant_id: string;
    function_id: string;
    enabled: boolean;
    stage: 'dev' | 'production';
    created_at: string;
    updated_at: string;

    // Optional expanded relationship
    function?: {
        id: string;
        name: string;
        type: 'zapier' | 'supabase' | 'internal';
        allowed_method: 'GET' | 'POST';
        description?: string;
        endpoint_url?: string;
        input_schema: Record<string, any>;
        output_schema?: Record<string, any>;
    };
};
